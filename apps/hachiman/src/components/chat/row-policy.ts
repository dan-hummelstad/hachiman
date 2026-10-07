import { Permissions, has, type Channel } from '@hachiman/client'
import { canHoldThreads } from '@/components/threads/thread-name'

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
