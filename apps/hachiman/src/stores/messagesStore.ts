import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Message } from '@hachiman/client'
import type {
  AttachmentPointer,
  DecryptedSender,
  DecryptFailure,
  DecryptResult,
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
  /** The verified sender device, or null for an optimistic row or a row that did not decrypt. */
  sender: DecryptedSender | null
  decrypt: DecryptState
  pending?: boolean
  failed?: boolean
  /** Why the send failed, in words for the user. */
  sendError?: string
}

interface MessagesState {
  /** channelId → messages, oldest first. */
  byChannel: Map<string, ChatMessage[]>
  /** channelId → whether older history exists (unset = never loaded). */
  hasMore: Map<string, boolean>
  /** channelId → userId → typing-expiry (ms epoch). */
  typing: Map<string, Map<string, number>>
  /** Merge server messages by id; a message whose nonce matches a pending row replaces it. */
  upsert: (channelId: string, messages: ChatMessage[]) => void
  addPending: (message: ChatMessage) => void
  markFailed: (channelId: string, nonce: string, sendError?: string) => void
  remove: (channelId: string, messageId: string) => void
  setHasMore: (channelId: string, hasMore: boolean) => void
  setTyping: (channelId: string, userId: string, until: number | null) => void
}

const byTime = (a: ChatMessage, b: ChatMessage): number =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)

type MessagesData = Pick<MessagesState, 'byChannel' | 'hasMore' | 'typing'>

const initialMessagesState = (): MessagesData => ({
  byChannel: new Map(),
  hasMore: new Map(),
  typing: new Map()
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
        const list = s.byChannel.get(channelId)
        if (!list) return {}
        return {
          byChannel: new Map(s.byChannel).set(
            channelId,
            list.filter((m) => m.id !== messageId)
          )
        }
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
      })
  }))
)

let epoch = 0
/** Bumped by every reset, so requests started before a sign-out can drop their late results. */
export const messagesEpoch = (): number => epoch

export function resetMessagesStore(): void {
  epoch++
  useMessageStore.setState(initialMessagesState())
}

/**
 * A new gateway session (READY) has a gap: events between the sessions are lost. Drops the
 * loaded history, so the next load fetches the latest page. Unsent rows stay.
 */
export function dropHistory(): void {
  epoch++
  useMessageStore.setState((s) => {
    const byChannel = new Map<string, ChatMessage[]>()
    for (const [id, list] of s.byChannel) {
      const unsent = list.filter((m) => m.pending)
      if (unsent.length > 0) byChannel.set(id, unsent)
    }
    return { byChannel, hasMore: new Map(), typing: new Map() }
  })
}
