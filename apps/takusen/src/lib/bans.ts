/**
 * Guild bans (docs/gateway-protocol.md §4 Bans). A ban removes the member
 * through the leave path (§12.18 `member_left`, in the same transaction) and
 * keeps the user out: the invite accept refuses a banned user (`assertNotBanned`).
 */
import { and, desc, eq } from 'drizzle-orm'
import type { Ban } from '@hachiman/client/types'

import { db, type Tx } from '@/db/client'
import { guildBans, users } from '@/db/schema'
import { ApiError, NotFoundError } from '@/lib/errors'
import { getUserById, membershipTransaction, publishMemberRemoved, removeMemberIn, userColumns } from '@/lib/guilds'
import type { RevokedInvite } from '@/lib/invite-limits'
import { toUser } from '@/lib/wire'

export const BAN_REASON_MAX = 512

export async function assertNotBanned(tx: Tx, guildId: string, userId: string): Promise<void> {
  const [row] = await tx
    .select({ userId: guildBans.userId })
    .from(guildBans)
    .where(and(eq(guildBans.guildId, guildId), eq(guildBans.userId, userId)))
    .limit(1)
  if (row) throw new ApiError('Banned', 403, 'You are banned from this guild')
}

/**
 * Bans `userId`, and removes the membership when there is one. A second ban
 * keeps the first row (Discord: PUT is idempotent). The caller has checked
 * BAN_MEMBERS, the owner and the role hierarchy.
 */
export async function banUser(opts: {
  guildId: string
  userId: string
  reason: string | null
  bannedBy: string
  actorDeviceId: string | null
}): Promise<void> {
  const user = await getUserById(opts.userId)
  if (!user) throw new NotFoundError('Unknown user')
  const revoked: RevokedInvite[] | null = await membershipTransaction(async (tx) => {
    await tx
      .insert(guildBans)
      .values({ guildId: opts.guildId, userId: opts.userId, reason: opts.reason, bannedBy: opts.bannedBy })
      .onConflictDoNothing()
    return removeMemberIn(tx, opts.guildId, opts.userId, opts.actorDeviceId)
  })
  if (revoked) await publishMemberRemoved(opts.guildId, user, revoked)
}

export async function unbanUser(guildId: string, userId: string): Promise<void> {
  const deleted = await db
    .delete(guildBans)
    .where(and(eq(guildBans.guildId, guildId), eq(guildBans.userId, userId)))
    .returning({ userId: guildBans.userId })
  if (deleted.length === 0) throw new NotFoundError('Unknown ban')
}

/** Newest first. */
export async function listBans(guildId: string): Promise<Ban[]> {
  const rows = await db
    .select({ user: userColumns, reason: guildBans.reason, createdAt: guildBans.createdAt })
    .from(guildBans)
    .innerJoin(users, eq(users.id, guildBans.userId))
    .where(eq(guildBans.guildId, guildId))
    .orderBy(desc(guildBans.createdAt))
  return rows.map((r) => ({ user: toUser(r.user), reason: r.reason, createdAt: r.createdAt.toISOString() }))
}
