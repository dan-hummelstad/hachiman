/**
 * Thread rules (docs/gateway-protocol.md §4 Threads). A thread is a channel of
 * type `thread` under a guild text channel. It has the permissions and the MLS
 * group of its parent (§2, §12.6).
 */
import { has, Permissions } from '@hachiman/client/permissions'

import { THREAD_PARENT_TYPE } from '@/lib/channel-types'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'

/**
 * The most threads that GET /channels/:id/threads returns, and that GuildFull
 * (REST and READY, readyThreadCap in the gateway) carries per guild.
 */
export const THREAD_LIST_MAX = 50

/**
 * The channel whose permissions and MLS group a channel uses (§2, §12.6): the
 * parent for a thread, else the channel itself. A thread without a parent gives
 * null: the caller grants nothing.
 */
export function sourceChannelId(c: { id: string; type: string; parentId: string | null }): string | null {
  return c.type === 'thread' ? c.parentId : c.id
}

/** POST /channels/:id/threads: a guild text channel, and SEND_MESSAGES on it. */
export function assertCanCreateThread(parent: { type: string; guildId: string | null }, permissions: number): void {
  if (parent.guildId === null || parent.type !== THREAD_PARENT_TYPE) {
    throw new ValidationError('Only a guild text channel can have threads')
  }
  if (!has(permissions, Permissions.SEND_MESSAGES)) throw new MissingPermissionsError()
}

/** PATCH and DELETE of a thread: MANAGE_CHANNELS (on the parent), or the creator. */
export function canManageThread(thread: { ownerId: string | null }, userId: string, permissions: number): boolean {
  return thread.ownerId === userId || has(permissions, Permissions.MANAGE_CHANNELS)
}
