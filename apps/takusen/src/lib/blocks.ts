/**
 * User blocks (docs/gateway-protocol.md §4 "Pins, guild events and blocks"). A block in either
 * direction refuses a new DM and a message into a 1:1 DM with 403 `Blocked`.
 * Guild channels are not affected: the client hides blocked authors there.
 */
import { and, eq, inArray, or } from 'drizzle-orm'

import { db } from '@/db/client'
import { userBlocks } from '@/db/schema'
import { ApiError } from '@/lib/errors'

export function blockedError(): ApiError {
  return new ApiError('Blocked', 403, 'You cannot message this user')
}

/** True when a block exists between `userId` and any of `others`, in either direction. */
export async function hasBlockBetween(userId: string, others: readonly string[]): Promise<boolean> {
  if (others.length === 0) return false
  const [row] = await db
    .select({ userId: userBlocks.userId })
    .from(userBlocks)
    .where(
      or(
        and(eq(userBlocks.userId, userId), inArray(userBlocks.blockedUserId, [...others])),
        and(inArray(userBlocks.userId, [...others]), eq(userBlocks.blockedUserId, userId)),
      ),
    )
    .limit(1)
  return row !== undefined
}

/** 403 `Blocked` when a block exists between `userId` and any of `others`. */
export async function assertNotBlocked(userId: string, others: readonly string[]): Promise<void> {
  if (await hasBlockBetween(userId, others)) throw blockedError()
}
