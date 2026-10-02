/**
 * Decrypt before store (§12.8.5): every ciphertext Message goes through the crypto Worker, and only
 * the result goes into messagesStore. No envelope is ever stored as text.
 *
 * - 'ok': the decrypted row replaces the row of that id (an edit replaces the content).
 * - 'pending': a placeholder row. The ciphertext waits here, and `retryGroup` decrypts it again
 *   when the Worker emits epochKeysAvailable. A row that already shows content keeps it.
 * - 'failed': an "unable to decrypt" row with the reason. 'stale_edit' (a rollback by the server)
 *   keeps the newer content that the store has.
 *
 * Plain dependencies, so the order of decrypt and upsert is testable without a Worker.
 */
import type { Message } from '@hachiman/client'
import type { DecryptResult, EncryptedMessage } from '@hachiman/crypto'
import type { ChatMessage, DecryptState } from '@/stores/messagesStore'

export interface DecryptorDeps {
  /** CryptoApi.decryptMessages. */
  decrypt(messages: EncryptedMessage[]): Promise<DecryptResult[]>
  /** The row that the store shows now for a message id. */
  existing(channelId: string, messageId: string): ChatMessage | undefined
  upsert(channelId: string, rows: ChatMessage[]): void
}

export interface MessageDecryptor {
  /**
   * Decrypts `messages` (any order; they go to the Worker in history order) and upserts the rows.
   * Calls run one after another, so a later event never lands before an earlier one. Resolves the
   * rows that went into the store (empty after a `reset` during the call).
   */
  ingest(messages: Message[]): Promise<ChatMessage[]>
  /** Decrypts again every pending message of `groupId`. */
  retryGroup(groupId: string): Promise<ChatMessage[]>
  /** Decrypts again every pending message (the Worker became ready). */
  retryAll(): Promise<ChatMessage[]>
  /** Forgets a deleted message. */
  forget(messageId: string): void
  /** Sign-out: drops the waiting ciphertext, and results of calls still running. */
  reset(): void
  /** Message ids that wait for keys (tests and diagnostics). */
  pendingIds(): string[]
}

/** The §12.8.5 input of one row. `attachments` are the upload rows: the id and the blob size. */
export function toEncrypted(m: Message): EncryptedMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    guildId: m.guildId,
    authorId: m.author.id,
    senderDevice: m.senderDevice,
    groupId: m.groupId,
    epoch: m.epoch,
    clientMsgId: m.clientMsgId,
    envelope: m.envelope,
    attachments: m.attachments.map((a) => ({ id: a.id, size: a.size })),
    createdAt: m.createdAt,
    editedAt: m.editedAt
  }
}

const historyOrder = (a: Message, b: Message): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

function baseRow(m: Message): Omit<ChatMessage, 'decrypt'> {
  const row: Omit<ChatMessage, 'decrypt'> = {
    id: m.id,
    channelId: m.channelId,
    guildId: m.guildId,
    author: m.author,
    groupId: m.groupId,
    epoch: m.epoch,
    clientMsgId: m.clientMsgId,
    createdAt: m.createdAt,
    editedAt: m.editedAt,
    content: '',
    mentions: [],
    attachments: [],
    replyTo: null,
    sender: null
  }
  if (m.nonce !== undefined) row.nonce = m.nonce
  return row
}

/**
 * The row for one result, or null when the store keeps what it shows. `existing` is the row that
 * the store has for this id.
 */
export function rowFor(
  m: Message,
  r: DecryptResult,
  existing: ChatMessage | undefined
): ChatMessage | null {
  const shows = existing?.decrypt.status === 'ok' && !existing.pending ? existing : undefined
  if (r.status === 'ok') {
    const c = r.content
    return {
      ...baseRow(m),
      content: c.text,
      mentions: c.mentions,
      attachments: c.attachments,
      replyTo: c.replyTo,
      sender: r.sender,
      decrypt: { status: 'ok' }
    }
  }
  if (r.status === 'pending') {
    // An edit whose keys are not here yet: keep the content that the row shows.
    if (shows) return null
    return { ...baseRow(m), decrypt: { status: 'pending', reason: r.reason } }
  }
  // A rollback to an older version (§12.8.5 step 10): keep the newer content.
  if (r.reason === 'stale_edit' && shows) return null
  const decrypt: DecryptState = { status: 'failed', reason: r.reason }
  return { ...baseRow(m), decrypt }
}

export function createMessageDecryptor(deps: DecryptorDeps): MessageDecryptor {
  /** groupId → messageId → the ciphertext that waits for keys. */
  const waiting = new Map<string, Map<string, Message>>()
  let generation = 0
  let queue: Promise<unknown> = Promise.resolve()

  const unwait = (id: string): void => {
    for (const [groupId, byId] of waiting) {
      if (byId.delete(id) && byId.size === 0) waiting.delete(groupId)
    }
  }

  /** `started`: the generation when the call was made, so a reset before it ran drops it too. */
  async function run(messages: Message[], started: number): Promise<ChatMessage[]> {
    if (messages.length === 0 || started !== generation) return []
    const ordered = [...messages].sort(historyOrder)
    let results: DecryptResult[]
    try {
      results = await deps.decrypt(ordered.map(toEncrypted))
    } catch (e) {
      // The Worker is not there (signed out, not set up): keep everything for the next retry.
      if (started !== generation) return []
      console.warn('[messages] decrypt failed', e)
      results = ordered.map((m) => ({
        status: 'pending',
        messageId: m.id,
        reason: 'group_unknown'
      }))
    }
    if (started !== generation) return []
    const byId = new Map(results.map((r) => [r.messageId, r]))
    const rows = new Map<string, ChatMessage[]>()
    const out: ChatMessage[] = []
    for (const m of ordered) {
      // Fail closed: a result that the Worker did not return is not content.
      const r = byId.get(m.id) ?? { status: 'failed', messageId: m.id, reason: 'malformed' }
      unwait(m.id)
      if (r.status === 'pending') {
        let g = waiting.get(m.groupId)
        if (!g) waiting.set(m.groupId, (g = new Map()))
        g.set(m.id, m)
      }
      const row = rowFor(m, r, deps.existing(m.channelId, m.id))
      if (!row) continue
      let list = rows.get(m.channelId)
      if (!list) rows.set(m.channelId, (list = []))
      list.push(row)
      out.push(row)
    }
    for (const [channelId, list] of rows) deps.upsert(channelId, list)
    return out
  }

  const enqueue = (messages: () => Message[]): Promise<ChatMessage[]> => {
    const started = generation
    const next = queue.then(() => run(messages(), started))
    queue = next.catch(() => undefined)
    return next
  }

  return {
    ingest: (messages) => enqueue(() => messages),
    retryGroup: (groupId) => enqueue(() => [...(waiting.get(groupId)?.values() ?? [])]),
    retryAll: () => enqueue(() => [...waiting.values()].flatMap((g) => [...g.values()])),
    forget: unwait,
    reset() {
      generation++
      waiting.clear()
    },
    pendingIds: () => [...waiting.values()].flatMap((g) => [...g.keys()])
  }
}
