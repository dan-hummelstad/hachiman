/**
 * Invite limits (contract §4 "Invite limits"). A user without ADMINISTRATOR
 * makes only invites that expire within 24 hours. Only an administrator makes
 * a permanent invite, and only with `acknowledgedPermanent: true`. When the
 * creator of a permanent invite loses ADMINISTRATOR, the route that caused it
 * revokes the invite in its transaction.
 *
 * This module does not import `lib/guilds.ts`: `removeMember` there calls it,
 * and `lib/invites.ts` imports `lib/guilds.ts`.
 */
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { computeBasePermissions, has, Permissions } from '@hachiman/client/permissions'

import type { Tx } from '@/db/client'
import { invites } from '@/db/schema'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import type { GuildPermissionData } from '@/lib/mls/repo'
import { drizzleMlsRepo } from '@/lib/mls/repo.drizzle'

/** The longest invite that a user without ADMINISTRATOR can make. */
export const MAX_LIMITED_INVITE_AGE_S = 86_400
/** The longest invite with an expiry (zod rejects more for everyone). */
export const MAX_INVITE_AGE_S = 7 * 86_400

/** Call after the zod parse. A non-admin gets the 403, also when the acknowledgment is missing. */
export function assertInviteLimits(body: { maxAgeSeconds: number; acknowledgedPermanent?: boolean }, isAdmin: boolean): void {
  if (!isAdmin && (body.maxAgeSeconds === 0 || body.maxAgeSeconds > MAX_LIMITED_INVITE_AGE_S)) {
    throw new MissingPermissionsError('Only an administrator can make an invite that is permanent or lasts longer than 24 hours')
  }
  if (body.maxAgeSeconds === 0 && body.acknowledgedPermanent !== true) {
    throw new ValidationError('A permanent invite needs acknowledgedPermanent: true')
  }
}

/** The creators that are not members of the guild or do not have ADMINISTRATOR. Mirrors `readersFrom`. */
export function creatorsWithoutAdmin(data: GuildPermissionData, creators: Iterable<string>): Set<string> {
  const out = new Set<string>()
  for (const id of creators) {
    const roles = data.members.get(id)
    if (!roles || !has(computeBasePermissions(data.guild, { user: { id }, roles }, data.roles), Permissions.ADMINISTRATOR)) {
      out.add(id)
    }
  }
  return out
}

export interface RevokedInvite {
  inviteId: string
  code: string
}

/**
 * Call in the transaction of a role edit, role delete, member-role edit or
 * member removal: after the write and before `membershipChanged`. It revokes
 * the permanent invites whose creator no longer has ADMINISTRATOR, for the
 * whole guild, because one role change can demote many users. The read sees
 * the uncommitted write of the transaction. Without permanent invites it is
 * one query. Publish the result with `publishInviteDeletes` after the commit.
 */
export async function revokePermanentInvitesOfNonAdmins(tx: Tx, guildId: string): Promise<RevokedInvite[]> {
  const rows = await tx
    .select({ id: invites.id, code: invites.code, createdBy: invites.createdBy })
    .from(invites)
    .where(and(eq(invites.guildId, guildId), eq(invites.revoked, false), isNull(invites.expiresAt)))
  if (rows.length === 0) return []
  const data = await drizzleMlsRepo(tx).getGuildPermissionData(guildId)
  if (!data) return []
  const lost = creatorsWithoutAdmin(data, new Set(rows.map((r) => r.createdBy)))
  const hit = rows.filter((r) => lost.has(r.createdBy))
  if (hit.length === 0) return []
  await tx
    .update(invites)
    .set({ revoked: true })
    .where(inArray(invites.id, hit.map((r) => r.id)))
  return hit.map((r) => ({ inviteId: r.id, code: r.code }))
}

/** `INVITE_DELETE` → guild for each revoked invite. Call after the commit. */
export async function publishInviteDeletes(guildId: string, revoked: readonly RevokedInvite[]): Promise<void> {
  for (const r of revoked) {
    await publishToGuild(guildId, 'INVITE_DELETE', { guildId, code: r.code, inviteId: r.inviteId })
  }
}
