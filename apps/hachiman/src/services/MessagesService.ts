import { RestError, type Message } from '@hachiman/client'
import {
  CryptoError,
  type AttachmentPointer,
  type EncryptMessageInput,
  type MessageContent
} from '@hachiman/crypto'
import { uploadIdsOf } from '@/lib/attachments'
import { mentionsOf } from '@/lib/mentions'
import { errMsg } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/client'
import { createMessageDecryptor } from '@/services/message-decrypt'
import { sealPushPreviews } from '@/services/PushService'
import { playSound } from '@/services/SoundService'
import {
  dropHistory,
  messagesEpoch,
  reactionEventOf,
  useMessageStore,
  type ChatMessage,
  type ReactionEvent
} from '@/stores/messagesStore'
import { useUserStore } from '@/stores/userStore'

const PAGE_SIZE = 50
const TYPING_THROTTLE_MS = 8_000
/** Tries of one send or edit when the group moved on (§12.8.3). */
const SEND_ATTEMPTS = 4
const RETRY_BASE_MS = 300

let lastTyping = { channelId: '', at: 0 }
/** channelId → the history page request in flight, so overlapping triggers share one fetch. */
const loading = new Map<string, Promise<void>>()
/** Channels whose group this device joined, or is joining, in this session (§12.7.8). */
const joined = new Set<string>()

/**
 * A device joins the group of a channel on its first open, not only on its first send (§12.7.8):
 * a member who only reads gets the keys too. Best effort: a failure tries again on the next open.
 */
function joinGroup(channelId: string): void {
  if (joined.has(channelId)) return
  let crypto
  try {
    crypto = cryptoService.client()
  } catch {
    return // not ready: the next open tries again
  }
  joined.add(channelId)
  void crypto.ensureChannelGroup(channelId).catch((e: unknown) => {
    joined.delete(channelId)
    console.warn('[messages] channel group join failed', e)
  })
}

const decryptor = createMessageDecryptor({
  decrypt: (messages) => cryptoService.client().decryptMessages(messages),
  existing: (channelId, messageId) =>
    useMessageStore
      .getState()
      .byChannel.get(channelId)
      ?.find((m) => m.id === messageId),
  upsert: (channelId, rows) => useMessageStore.getState().upsert(channelId, rows),
  reactions: (channelId, events) => useMessageStore.getState().applyReactions(channelId, events)
})

async function fetchOlder(channelId: string): Promise<void> {
  const store = useMessageStore.getState()
  const startedIn = messagesEpoch()
  const oldest = store.byChannel.get(channelId)?.find((m) => !m.pending)
  const page = await hachiman.rest.getMessages(channelId, {
    before: store.hasMore.has(channelId) ? oldest?.id : undefined,
    limit: PAGE_SIZE
  })
  if (messagesEpoch() !== startedIn) return // signed out or history dropped meanwhile
  await decryptor.ingest(page)
  if (messagesEpoch() !== startedIn) return
  store.setHasMore(channelId, page.length === PAGE_SIZE)
}

/** The group moved on or is not active yet: catch up, then encrypt again (§12.8.3). */
function retryable(e: unknown): boolean {
  const code =
    e instanceof RestError ? e.code : e instanceof CryptoError ? (e.dsCode ?? e.code) : null
  return (
    code === 'StaleEpoch' ||
    code === 'GroupPending' ||
    code === 'EpochConflict' ||
    code === 'PendingRemoves'
  )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Encrypt for the current group of the channel and post. A retry encrypts again: a new message
 * gets a new client_msg_id, an edit keeps the one of the original (§12.8.6).
 */
async function sealAndPost(
  channelId: string,
  input: EncryptMessageInput,
  post: (envelope: string) => Promise<Message>
): Promise<Message> {
  for (let attempt = 1; ; attempt++) {
    try {
      const crypto = cryptoService.client()
      await crypto.ensureChannelGroup(channelId)
      const sealed = await crypto.encryptMessage(input)
      return await post(sealed.envelope)
    } catch (e) {
      if (attempt >= SEND_ATTEMPTS || !retryable(e)) throw e
      await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
    }
  }
}

/** The send error of a 1:1 DM with a block in either direction (403 Blocked, contract §4). */
export const BLOCKED_SEND_ERROR = "You can't message this person."

/** A failed send or edit, in words for the user. */
export function sendErrorText(e: unknown): string {
  if (e instanceof RestError && e.code === 'Blocked') return BLOCKED_SEND_ERROR
  if (e instanceof CryptoError && e.code === 'TooLarge')
    return 'This message is too long. Make it shorter.'
  if (e instanceof RestError && e.code === 'EnvelopeTooLarge')
    return 'This message is too long. Make it shorter.'
  if (e instanceof CryptoError && e.code === 'NotInitialized')
    return 'Encryption is not ready on this device yet.'
  if (retryable(e)) return 'The channel keys changed while sending. Try again.'
  return errMsg(e)
}

/** The user id for an `@username` in this channel: a guild member or a DM participant. */
function resolveUsername(channelId: string, username: string): string | null {
  const name = username.toLowerCase()
  const { cache } = hachiman
  const channel = cache.channels.get(channelId)
  if (!channel) return null
  if (channel.guildId === null) {
    const users = [...(channel.recipients ?? []), ...(cache.user ? [cache.user] : [])]
    return users.find((u) => u.username.toLowerCase() === name)?.id ?? null
  }
  const members = [...(cache.members.get(channel.guildId)?.values() ?? [])]
  const member = members.find(
    (m) => m.user.username.toLowerCase() === name || m.nick?.toLowerCase() === name
  )
  return member?.user.id ?? null
}

export const messagesService = {
  /**
   * Load the page before the oldest loaded message (or the latest page on first load). No-op once
   * history is exhausted; joins the in-flight request if one is running. Never rejects (logs).
   */
  loadOlder(channelId: string): Promise<void> {
    const running = loading.get(channelId)
    if (running) return running
    if (useMessageStore.getState().hasMore.get(channelId) === false) return Promise.resolve()
    const request = fetchOlder(channelId)
      .catch((e) => console.warn('[messages] history failed', e))
      .finally(() => loading.delete(channelId))
    loading.set(channelId, request)
    return request
  },

  /** Channel open: join its group, and load the latest page unless the history is loaded. */
  ensureLoaded(channelId: string): void {
    joinGroup(channelId)
    if (!useMessageStore.getState().hasMore.has(channelId))
      void messagesService.loadOlder(channelId)
  },

  /** Decrypts server messages (history, MESSAGE_CREATE, MESSAGE_UPDATE) into the store. */
  ingest(messages: Message[]): Promise<ChatMessage[]> {
    return decryptor.ingest(messages)
  },

  /** epochKeysAvailable: the pending messages of the group decrypt again. */
  retryGroup(groupId: string): void {
    void decryptor.retryGroup(groupId)
  },

  /** The Worker became ready: every pending message decrypts again. */
  retryAll(): void {
    void decryptor.retryAll()
  },

  /** A deleted message no longer waits for keys. */
  forget(messageId: string): void {
    decryptor.forget(messageId)
  },

  /** READY of a new gateway session: the history has a gap. The open channel loads again. */
  onNewSession(openChannelId: string | null): void {
    loading.clear() // their results belong to the dropped history
    dropHistory()
    if (openChannelId) messagesService.ensureLoaded(openChannelId)
  },

  /** Sign-out. */
  reset(): void {
    joined.clear()
    decryptor.reset()
  },

  /**
   * Optimistic send: a pending row keyed by nonce, replaced by the decrypted echo (REST response
   * or MESSAGE_CREATE). `attachments` are finished encrypted uploads; the pending row renders
   * them already. `replyTo` is the client_msg_id of the message that this one answers (N11).
   */
  async send(
    channelId: string,
    content: string,
    attachments: AttachmentPointer[] = [],
    replyTo: string | null = null
  ): Promise<void> {
    const text = content.trim()
    const me = useUserStore.getState().me
    if ((!text && attachments.length === 0) || !me) return
    const nonce = crypto.randomUUID()
    const mentions = mentionsOf(text, (u) => resolveUsername(channelId, u))
    const store = useMessageStore.getState()
    store.addPending({
      id: nonce,
      nonce,
      channelId,
      guildId: hachiman.cache.channels.get(channelId)?.guildId ?? null,
      author: me,
      groupId: '',
      epoch: -1,
      clientMsgId: '',
      content: text,
      mentions,
      attachments,
      replyTo,
      sender: null,
      decrypt: { status: 'ok' },
      createdAt: new Date().toISOString(),
      editedAt: null,
      pending: true
    })
    playSound('messageSent')
    lastTyping = { channelId: '', at: 0 }
    const body: Omit<MessageContent, 'sentAtMs'> = { text, mentions, attachments, replyTo }
    // The previews seal while the envelope does; they never fail the send (PushService).
    const push = sealPushPreviews(channelId, text, mentions, attachments)
    try {
      const ids = uploadIdsOf(attachments)
      const sent = await sealAndPost(
        channelId,
        { channelId, kind: 'message', editOf: null, content: body },
        async (envelope) =>
          hachiman.rest.sendMessage(channelId, {
            envelope,
            nonce,
            attachments: ids.length > 0 ? ids : undefined,
            push: await push
          })
      )
      await decryptor.ingest([sent])
    } catch (err) {
      console.error('[messages] send failed', err)
      useMessageStore.getState().markFailed(channelId, nonce, sendErrorText(err))
    }
  },

  /**
   * Re-send a failed optimistic message: drop its row, send it as a fresh pending one. Its uploads
   * were never claimed, so their ids are still good.
   */
  async retry(message: ChatMessage): Promise<void> {
    messagesService.discard(message)
    await messagesService.send(
      message.channelId,
      message.content,
      message.attachments,
      message.replyTo
    )
  },

  /**
   * Adds (`remove` false) or takes back one emoji on a message (N10): a new message of kind
   * 'reaction'. The store shows it at once; a failed send takes it back and rejects with an Error
   * whose message is for the user.
   */
  async react(
    channelId: string,
    targetClientMsgId: string,
    emoji: string,
    remove = false
  ): Promise<void> {
    const me = useUserStore.getState().me
    if (!me || !targetClientMsgId || !emoji) return
    const nonce = crypto.randomUUID()
    const store = useMessageStore.getState()
    const previous = reactionEventOf(channelId, targetClientMsgId, me.id, emoji)
    // Optimistic: the echo has a later sentAtMs, so it replaces this event in the fold.
    const optimistic: ReactionEvent = {
      messageId: nonce,
      target: targetClientMsgId,
      userId: me.id,
      emoji,
      remove,
      sentAtMs: Date.now(),
      createdAt: new Date().toISOString()
    }
    store.applyReactions(channelId, [optimistic])
    try {
      const sent = await sealAndPost(
        channelId,
        {
          channelId,
          kind: 'reaction',
          editOf: null,
          content: { target: targetClientMsgId, emoji, remove }
        },
        (envelope) => hachiman.rest.sendMessage(channelId, { envelope, nonce, silent: true })
      )
      await decryptor.ingest([sent])
    } catch (err) {
      // The pair shows what it showed before: a failed un-react keeps the reaction.
      useMessageStore.getState().restoreReaction(channelId, optimistic, previous)
      throw new Error(sendErrorText(err), { cause: err })
    }
  },

  /** Drop a failed optimistic message locally (it never reached the server). */
  discard(message: ChatMessage): void {
    useMessageStore.getState().remove(message.channelId, message.id)
  },

  /**
   * A new envelope (kind 2) with the new text and the original attachments. It keeps the
   * client_msg_id of the original. '' is valid only for a message with attachments. Rejects with
   * an Error whose message is for the user.
   */
  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    const row = useMessageStore
      .getState()
      .byChannel.get(channelId)
      ?.find((m) => m.id === messageId)
    if (!row || row.pending || row.decrypt.status !== 'ok' || !row.clientMsgId)
      throw new Error('This message cannot be edited.')
    const text = content.trim()
    const mentions = mentionsOf(text, (u) => resolveUsername(channelId, u))
    try {
      const updated = await sealAndPost(
        channelId,
        {
          channelId,
          kind: 'edit',
          editOf: row.clientMsgId,
          content: { text, mentions, attachments: row.attachments, replyTo: row.replyTo }
        },
        (envelope) => hachiman.rest.editMessage(channelId, messageId, { envelope })
      )
      await decryptor.ingest([updated])
    } catch (err) {
      throw new Error(sendErrorText(err), { cause: err })
    }
  },

  async delete(channelId: string, messageId: string): Promise<void> {
    await hachiman.rest.deleteMessage(channelId, messageId)
    decryptor.forget(messageId)
    useMessageStore.getState().remove(channelId, messageId)
  },

  /** Throttled TYPING_START trigger; call on every keystroke. */
  typing(channelId: string): void {
    const now = Date.now()
    if (lastTyping.channelId === channelId && now - lastTyping.at < TYPING_THROTTLE_MS) return
    lastTyping = { channelId, at: now }
    void hachiman.rest.triggerTyping(channelId).catch(() => {})
  }
}
