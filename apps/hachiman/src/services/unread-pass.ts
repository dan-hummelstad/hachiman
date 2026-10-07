/**
 * The restart mention pass (N7). The server cannot see mentions (they are in the envelope), so after
 * a restart the client fetches the unread messages of a few channels, decrypts them and counts the
 * mentions of me. The decrypted rows are counted, not stored.
 */
import type { Message } from '@hachiman/client'
import type { ChannelUnread } from '@/stores/unreadStore'
import type { ChatMessage } from '@/stores/messagesStore'

/** At most this many channels per pass. */
export const PASS_CHANNELS = 20
/** At most this many messages per channel. */
export const PASS_MESSAGES = 50

export interface PassDeps {
  /** The newest `limit` messages of the channel, oldest first. */
  fetchLatest(channelId: string, limit: number): Promise<Message[]>
  /** Decrypted rows of the messages that decrypt; the others are left out. */
  decrypt(messages: Message[]): Promise<ChatMessage[]>
  /** Whether a decrypted row from someone else mentions me. */
  mentionsMe(row: ChatMessage): boolean
}

/** The messages of `page` after `lastReadId`; with it not in the page, the newest `unread`. */
export function unreadTail(
  page: readonly Message[],
  lastReadId: string | null,
  unread: number
): Message[] {
  const at = lastReadId === null ? -1 : page.findIndex((m) => m.id === lastReadId)
  if (at >= 0) return page.slice(at + 1)
  return page.slice(Math.max(0, page.length - unread))
}

/**
 * Counts the mentions of the channels in `order` that have unread messages (at most
 * PASS_CHANNELS). A channel that fails is skipped. Resolves channelId → mention message ids.
 */
export async function mentionPass(
  order: readonly [string, ChannelUnread][],
  deps: PassDeps
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  const picked = order.filter(([, c]) => c.unread > 0).slice(0, PASS_CHANNELS)
  for (const [channelId, c] of picked) {
    try {
      const page = await deps.fetchLatest(channelId, PASS_MESSAGES)
      const tail = unreadTail(page, c.lastReadId, c.unread)
      if (tail.length === 0) continue
      const rows = await deps.decrypt(tail)
      const ids = rows
        .filter((r) => r.decrypt.status === 'ok' && deps.mentionsMe(r))
        .map((r) => r.id)
      if (ids.length > 0) out.set(channelId, ids)
    } catch (e) {
      console.warn('[unread] mention pass failed for a channel', e)
    }
  }
  return out
}
