/**
 * Read state (docs/gateway-protocol.md §1 ReadState, §4 POST /channels/:id/ack).
 *
 * The read position of a user in a channel is the (created_at, id) of the last
 * read message, the order of the messages table. An ack only moves it forward.
 * The route calls `ackMessage` over `drizzleReadStateStore`. Tests use a fake
 * store and capture the publishes.
 */
import { and, eq, sql } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'

import { db } from '@/db/client'
import { messages } from '@/db/schema'
import { NotFoundError } from '@/lib/errors'
import { publishToUser } from '@/lib/events'
import { requirePermission } from '@/lib/guild-access'
import type { RateLimiter } from '@/lib/mls/context'

/** Acks per user and window. A client debounces its acks (about one per second per channel). */
export const ACK_RATE_LIMIT = { bucket: 'ack', limit: 120, windowSec: 60 } as const

export interface ReadStateStore {
  /** True when the message exists and belongs to the channel. */
  messageInChannel(channelId: string, messageId: string): Promise<boolean>
  /** Moves the read state to the message when it is after the current one. True when it moved. */
  advance(userId: string, channelId: string, messageId: string): Promise<boolean>
}

/**
 * POST /channels/:id/ack after loadChannelAccess. Throws 403 without
 * VIEW_CHANNEL, 404 UnknownMessage for a message of another channel, and 429.
 * Publishes READ_STATE_UPDATE to the user's sessions only when the state moved.
 */
export async function ackMessage(
  store: ReadStateStore,
  rate: RateLimiter,
  input: { userId: string; channelId: string; permissions: number; messageId: string },
): Promise<boolean> {
  requirePermission(input.permissions, Permissions.VIEW_CHANNEL)
  await rate.hit(ACK_RATE_LIMIT.bucket, input.userId, ACK_RATE_LIMIT.limit, ACK_RATE_LIMIT.windowSec)
  if (!(await store.messageInChannel(input.channelId, input.messageId))) throw new NotFoundError('Unknown message')
  const moved = await store.advance(input.userId, input.channelId, input.messageId)
  if (moved) {
    await publishToUser(input.userId, 'READ_STATE_UPDATE', { channelId: input.channelId, lastReadMessageId: input.messageId })
  }
  return moved
}

export const drizzleReadStateStore: ReadStateStore = {
  async messageInChannel(channelId, messageId) {
    const [row] = await db
      .select({ id: messages.id })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
      .limit(1)
    return row !== undefined
  },
  // One statement: the position is copied in SQL, so it keeps Postgres' microsecond precision.
  async advance(userId, channelId, messageId) {
    const res = await db.execute(sql`
      INSERT INTO read_states (user_id, channel_id, last_read_message_id, last_read_created_at, updated_at)
      SELECT ${userId}::uuid, m.channel_id, m.id, m.created_at, now()
      FROM messages m WHERE m.id = ${messageId}::uuid AND m.channel_id = ${channelId}::uuid
      ON CONFLICT (user_id, channel_id) DO UPDATE SET
        last_read_message_id = excluded.last_read_message_id,
        last_read_created_at = excluded.last_read_created_at,
        updated_at = excluded.updated_at
      WHERE (excluded.last_read_created_at, excluded.last_read_message_id)
          > (read_states.last_read_created_at, read_states.last_read_message_id)
      RETURNING 1`)
    return res.length > 0
  },
}
