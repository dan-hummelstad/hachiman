import { Permissions, has, type Channel } from '@hachiman/client'
import { canHoldThreads } from '@/components/threads/thread-name'
import type { ChatMessage } from '@/stores/messagesStore'

/** What I may do with the rows of one channel. ChannelChat builds it once for all rows. */
export interface RowPolicy {
  /** SEND_MESSAGES: reply and react (a reaction is a message, N10). */
  canSend: boolean
  /** MANAGE_MESSAGES: delete the messages of others. */
  canManage: boolean
  /** Pin and unpin (N13): MANAGE_MESSAGES in a guild, anyone in a DM. */
  canPin: boolean
  /** Start a thread from a row (N12): a channel that holds threads, and SEND_MESSAGES. */
  canThread: boolean
}

/** Whether I may pin and unpin in `channel` with permission bits `perms`. */
export const canPinIn = (channel: Pick<Channel, 'guildId'>, perms: number): boolean =>
  channel.guildId === null || has(perms, Permissions.MANAGE_MESSAGES)

export function rowPolicy(channel: Channel, perms: number): RowPolicy {
  const canSend = has(perms, Permissions.SEND_MESSAGES)
  return {
    canSend,
    canManage: has(perms, Permissions.MANAGE_MESSAGES),
    canPin: canPinIn(channel, perms),
    canThread: canSend && canHoldThreads(channel)
  }
}

/**
 * Which row the transcript shows for `message`. A blocked author's row collapses first, whatever
 * its kind (N23), until the user shows it. A page activity row needs its decrypted content; any
 * other row is a message row, which shows the placeholder of a row that did not decrypt.
 */
export type RowKind = 'blocked' | 'page_activity' | 'message'

export function rowKind(
  message: Pick<ChatMessage, 'blocked' | 'kind' | 'pageActivity' | 'decrypt'>,
  showBlocked = false
): RowKind {
  if (message.blocked && !showBlocked) return 'blocked'
  if (
    message.kind === 'page_activity' &&
    message.pageActivity !== undefined &&
    message.decrypt.status === 'ok'
  )
    return 'page_activity'
  return 'message'
}
