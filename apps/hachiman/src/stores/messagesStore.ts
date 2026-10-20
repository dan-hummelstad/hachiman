import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Message } from '@hachiman/client'
import type {
  AttachmentPointer,
  DecryptedSender,
  DecryptFailure,
  DecryptResult,
  LinkPreview,
  Mention
} from '@hachiman/crypto'

/** The decrypt result of a stored row (§12.8.5). */
export type DecryptState =
  | { status: 'ok' }
  /** The keys are not here yet. The row shows a placeholder and decrypts again on epochKeysAvailable. */
  | { status: 'pending'; reason: Extract<DecryptResult, { status: 'pending' }>['reason'] }
  /** The row shows "unable to decrypt" with the reason. */
  | { status: 'failed'; reason: DecryptFailure }

/**
 * A message as rendered: the decrypted content, never the envelope. The ciphertext fields that
 * the UI needs (group, epoch, client message id) stay; `envelope` does not.
 * Optimistic sends carry `pending` until the server echo (matched by nonce), and `failed` with
 * `sendError` when the send failed.
 */
export interface ChatMessage extends Omit<Message, 'envelope' | 'attachments' | 'senderDevice'> {
  /** Decrypted text. '' while the row does not decrypt. */
  content: string
  mentions: Mention[]
  /** Decrypted attachment pointers (name, MIME type, size, key), in envelope order. */
  attachments: AttachmentPointer[]
  replyTo: string | null
  /** The sender-made link preview (§12.8.1). Its image shows only through use-decrypted-blob. */
  linkPreview: LinkPreview | null
  /** The verified sender device, or null for an optimistic row or a row that did not decrypt. */
  sender: DecryptedSender | null
  decrypt: DecryptState
  pending?: boolean
  failed?: boolean
  /** Why the send failed, in words for the user. */
  sendError?: string
}

/**
 * One decrypted reaction message (N10, §12.8.1 kind 'reaction'). It never becomes a row: the
 * store folds it into `reactions` of its target.
 */
export interface ReactionEvent {
  /** The id of the reaction message itself (a delete of that message takes the event back). */
  messageId: string
  /** The client_msg_id of the target message in the same channel. */
  target: string
  /** The verified sender user. */
  userId: string
  emoji: string
  remove: boolean
  /** Sender clock: orders the events of one sender. */
  sentAtMs: number
  createdAt: string
}

/** emoji → the users who reacted with it. Emojis in the order of their oldest reaction. */
export type ReactionMap = ReadonlyMap<string, ReadonlySet<string>>

/** (user, emoji) → the newest event of that pair. */
type ReactionLog = Map<string, ReactionEvent>

interface MessagesState {
  /** channelId → messages, oldest first. */
  byChannel: Map<string, ChatMessage[]>
  /** channelId → whether older history exists (unset = never loaded). */
  hasMore: Map<string, boolean>
  /** channelId → userId → typing-expiry (ms epoch). */
  typing: Map<string, Map<string, number>>
  /** channelId → target client_msg_id → (user, emoji) → the newest reaction event. */
  reactionLog: Map<string, Map<string, ReactionLog>>
  /**
   * channelId → target client_msg_id → the folded reactions. Kept by client_msg_id, so a
   * reaction whose target is not loaded yet shows once the target loads.
   */
  reactions: Map<string, Map<string, ReactionMap>>
  /** Merge server messages by id; a message whose nonce matches a pending row replaces it. */
  upsert: (channelId: string, messages: ChatMessage[]) => void
  addPending: (message: ChatMessage) => void
  markFailed: (channelId: string, nonce: string, sendError?: string) => void
  remove: (channelId: string, messageId: string) => void
  setHasMore: (channelId: string, hasMore: boolean) => void
  setTyping: (channelId: string, userId: string, until: number | null) => void
  /** Folds decrypted reaction messages. A row with the id of a reaction (a placeholder) goes away. */
  applyReactions: (channelId: string, events: ReactionEvent[]) => void
  /**
   * Takes back a failed optimistic reaction: the (user, emoji) of `optimistic` gets `previous`
   * again (or no event). A newer event of that pair stays.
   */
  restoreReaction: (
    channelId: string,
    optimistic: ReactionEvent,
    previous: ReactionEvent | undefined
  ) => void
}

const byTime = (a: ChatMessage, b: ChatMessage): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

const reactionKey = (e: Pick<ReactionEvent, 'userId' | 'emoji'>): string =>
  `${e.userId}\u0000${e.emoji}`

/** True when `a` comes after `b` in sender order (ties: server order). */
const isNewer = (a: ReactionEvent, b: ReactionEvent): boolean =>
  a.sentAtMs !== b.sentAtMs
    ? a.sentAtMs > b.sentAtMs
    : a.createdAt !== b.createdAt
      ? a.createdAt > b.createdAt
      : a.messageId > b.messageId

/** The reactions of one target from its newest event per (user, emoji). Removes drop out. */
export function foldReactions(log: Iterable<ReactionEvent>): ReactionMap {
  const adds = [...log].filter((e) => !e.remove).sort((a, b) => (isNewer(a, b) ? 1 : -1))
  const out = new Map<string, Set<string>>()
  for (const e of adds) {
    let users = out.get(e.emoji)
    if (!users) out.set(e.emoji, (users = new Set()))
    users.add(e.userId)
  }
  return out
}

/** `reactions` with the targets of one channel folded again from `logs`. */
function refold(
  reactions: MessagesState['reactions'],
  channelId: string,
  logs: Map<string, ReactionLog>,
  targets: Iterable<string>
): MessagesState['reactions'] {
  const byTarget = new Map(reactions.get(channelId))
  for (const t of targets) {
    const log = logs.get(t)
    const folded = log ? foldReactions(log.values()) : null
    if (folded && folded.size > 0) byTarget.set(t, folded)
    else byTarget.delete(t)
  }
  return new Map(reactions).set(channelId, byTarget)
}

type MessagesData = Pick<
  MessagesState,
  'byChannel' | 'hasMore' | 'typing' | 'reactionLog' | 'reactions'
>

const initialMessagesState = (): MessagesData => ({
  byChannel: new Map(),
  hasMore: new Map(),
  typing: new Map(),
  reactionLog: new Map(),
  reactions: new Map()
})

export const useMessageStore = create<MessagesState>()(
  devtools((set) => ({
    ...initialMessagesState(),
    upsert: (channelId, incoming) =>
      set((s) => {
        if (incoming.length === 0) return {}
        const list = [...(s.byChannel.get(channelId) ?? [])]
        for (const m of incoming) {
          const i = list.findIndex((x) => x.id === m.id || (m.nonce && x.nonce === m.nonce))
          if (i >= 0) list[i] = m
          else list.push(m)
        }
        list.sort(byTime)
        return { byChannel: new Map(s.byChannel).set(channelId, list) }
      }),
    addPending: (message) =>
      set((s) => {
        const list = [...(s.byChannel.get(message.channelId) ?? []), message]
        return { byChannel: new Map(s.byChannel).set(message.channelId, list) }
      }),
    markFailed: (channelId, nonce, sendError) =>
      set((s) => {
        const list = s.byChannel.get(channelId)
        if (!list) return {}
        const next = list.map((m) =>
          m.nonce === nonce && m.pending ? { ...m, failed: true, sendError } : m
        )
        return { byChannel: new Map(s.byChannel).set(channelId, next) }
      }),
    remove: (channelId, messageId) =>
      set((s) => {
        const out: Partial<MessagesData> = {}
        const list = s.byChannel.get(channelId)
        if (list)
          out.byChannel = new Map(s.byChannel).set(
            channelId,
            list.filter((m) => m.id !== messageId)
          )
        // A deleted reaction message takes its event back.
        const logs = s.reactionLog.get(channelId)
        for (const [target, log] of logs ?? []) {
          for (const [key, e] of log) {
            if (e.messageId !== messageId) continue
            const nextLog = new Map(log)
            nextLog.delete(key)
            const nextLogs = new Map(logs).set(target, nextLog)
            out.reactionLog = new Map(s.reactionLog).set(channelId, nextLogs)
            out.reactions = refold(s.reactions, channelId, nextLogs, [target])
            return out
          }
        }
        return out
      }),
    setHasMore: (channelId, hasMore) =>
      set((s) => ({ hasMore: new Map(s.hasMore).set(channelId, hasMore) })),
    setTyping: (channelId, userId, until) =>
      set((s) => {
        const users = new Map(s.typing.get(channelId))
        if (until === null) {
          if (!users.has(userId)) return {}
          users.delete(userId)
        } else users.set(userId, until)
        return { typing: new Map(s.typing).set(channelId, users) }
      }),
    applyReactions: (channelId, events) =>
      set((s) => {
        if (events.length === 0) return {}
        const logs = new Map(s.reactionLog.get(channelId))
        const touched = new Set<string>()
        for (const e of events) {
          const prev = logs.get(e.target)?.get(reactionKey(e))
          if (prev && !isNewer(e, prev)) continue
          logs.set(e.target, new Map(logs.get(e.target)).set(reactionKey(e), e))
          touched.add(e.target)
        }
        const out: Partial<MessagesData> = {}
        const ids = new Set(events.map((e) => e.messageId))
        const list = s.byChannel.get(channelId)
        if (list?.some((m) => ids.has(m.id)))
          out.byChannel = new Map(s.byChannel).set(
            channelId,
            list.filter((m) => !ids.has(m.id))
          )
        if (touched.size > 0) {
          out.reactionLog = new Map(s.reactionLog).set(channelId, logs)
          out.reactions = refold(s.reactions, channelId, logs, touched)
        }
        return out
      }),
    restoreReaction: (channelId, optimistic, previous) =>
      set((s) => {
        const logs = s.reactionLog.get(channelId)
        const log = logs?.get(optimistic.target)
        const key = reactionKey(optimistic)
        if (!logs || !log || log.get(key)?.messageId !== optimistic.messageId) return {}
        const nextLog = new Map(log)
        if (previous) nextLog.set(key, previous)
        else nextLog.delete(key)
        const nextLogs = new Map(logs).set(optimistic.target, nextLog)
        return {
          reactionLog: new Map(s.reactionLog).set(channelId, nextLogs),
          reactions: refold(s.reactions, channelId, nextLogs, [optimistic.target])
        }
      })
  }))
)

/** The newest reaction event of (user, emoji) on a target, if the store has one. */
export function reactionEventOf(
  channelId: string,
  target: string,
  userId: string,
  emoji: string
): ReactionEvent | undefined {
  return useMessageStore
    .getState()
    .reactionLog.get(channelId)
    ?.get(target)
    ?.get(reactionKey({ userId, emoji }))
}

const EMPTY_REACTIONS: ReactionMap = new Map()

/** The reactions on a message, by its client_msg_id. A stable empty map when it has none. */
export function useReactions(channelId: string, clientMsgId: string): ReactionMap {
  return useMessageStore((s) => s.reactions.get(channelId)?.get(clientMsgId) ?? EMPTY_REACTIONS)
}

/**
 * The reply preview of a row (N11): 'ok' with the target row, 'encrypted' when the target did not
 * decrypt ("Encrypted message"), or 'missing' when it is not loaded ("Original message not loaded").
 */
export type ReplyPreview =
  | { status: 'ok'; message: ChatMessage }
  | { status: 'encrypted'; message: ChatMessage }
  | { status: 'missing' }

const MISSING: ReplyPreview = { status: 'missing' }

export function replyPreviewOf(
  list: readonly ChatMessage[] | undefined,
  replyTo: string
): ReplyPreview {
  const target = list?.find((m) => m.clientMsgId === replyTo)
  if (!target) return MISSING
  return target.decrypt.status === 'ok'
    ? { status: 'ok', message: target }
    : { status: 'encrypted', message: target }
}

/**
 * The target row of a reply (`replyTo` is a client_msg_id), or null when it is not loaded. The
 * selector returns the stored row itself, so the preview re-renders only when that row changes.
 * Pass the result to `replyPreviewOf([row], replyTo)` for the status, or read `decrypt` directly.
 */
export function useReplyTarget(channelId: string, replyTo: string | null): ChatMessage | null {
  return useMessageStore((s) =>
    replyTo === null
      ? null
      : (s.byChannel.get(channelId)?.find((m) => m.clientMsgId === replyTo) ?? null)
  )
}

let epoch = 0
/** Bumped by every reset, so requests started before a sign-out can drop their late results. */
export const messagesEpoch = (): number => epoch

export function resetMessagesStore(): void {
  epoch++
  useMessageStore.setState(initialMessagesState())
}

/**
 * A new gateway session (READY) has a gap: events between the sessions are lost. Drops the
 * loaded history, so the next load fetches the latest page. Unsent rows stay. The reactions go
 * with the history: the next load folds them again.
 */
export function dropHistory(): void {
  epoch++
  useMessageStore.setState((s) => {
    const byChannel = new Map<string, ChatMessage[]>()
    for (const [id, list] of s.byChannel) {
      const unsent = list.filter((m) => m.pending)
      if (unsent.length > 0) byChannel.set(id, unsent)
    }
    return {
      byChannel,
      hasMore: new Map(),
      typing: new Map(),
      reactionLog: new Map(),
      reactions: new Map()
    }
  })
}
