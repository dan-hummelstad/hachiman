/**
 * Invite limits (contract §4 "Invite limits"). A user without ADMINISTRATOR
 * makes only invites that expire within 24 hours. Only an administrator makes
 * a permanent invite, and only with `acknowledgedPermanent: true`, and only an
 * administrator makes an invite with history (§12.11.4). When the creator of
 * such an invite loses ADMINISTRATOR, the route that caused it revokes the
 * invite in its transaction.
 *
 * This module does not import `lib/guilds.ts`: `removeMember` there calls it,
 * and `lib/invites.ts` imports `lib/guilds.ts`.
 */
import { and, eq, isNotNull, isNull, or } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'

import type { Tx } from '@/db/client'
import { invites } from '@/db/schema'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import { drizzleInviteHistoryStore } from '@/lib/invite-history'
import { hasGuildPermission } from '@/lib/mls/readers'
import { drizzleMlsRepo } from '@/lib/mls/repo.drizzle'

/** The longest invite that a user without ADMINISTRATOR can make. */
export const MAX_LIMITED_INVITE_AGE_S = 86_400
/** The longest invite with an expiry (zod rejects more for everyone). */
export const MAX_INVITE_AGE_S = 7 * 86_400

/** Call after the zod parse. A non-admin gets the 403 (history, permanent, above 24 h), also when the acknowledgment is missing. */
export function assertInviteLimits(
  body: { maxAgeSeconds: number; acknowledgedPermanent?: boolean; record?: unknown },
  isAdmin: boolean,
): void {
  if (body.record !== undefined && !isAdmin) throw new MissingPermissionsError('Only an administrator can make an invite with history')
  if (!isAdmin && (body.maxAgeSeconds === 0 || body.maxAgeSeconds > MAX_LIMITED_INVITE_AGE_S)) {
    throw new MissingPermissionsError('Only an administrator can make an invite that is permanent or lasts longer than 24 hours')
  }
  if (body.maxAgeSeconds === 0 && body.acknowledgedPermanent !== true) {
    throw new ValidationError('A permanent invite needs acknowledgedPermanent: true')
  }
}

/**
 * Permanent, or with history (§4 "Invite limits", §12.11.4): only an
 * administrator makes it, and it is revoked when its creator loses
 * ADMINISTRATOR. Keep in step with needsAdministratorSql.
 */
export function needsAdministrator(i: { expiresAt: Date | null; record: Uint8Array | null }): boolean {
  return i.expiresAt === null || i.record !== null
}

export function needsAdministratorSql() {
  return or(isNull(invites.expiresAt), isNotNull(invites.record))
}

export interface RevokedInvite {
  inviteId: string
  code: string
}

/**
 * Call in the transaction of a role edit, role delete, member-role edit or
 * member removal: after the write and before `membershipChanged`. It revokes
 * the invites that need ADMINISTRATOR (permanent, or with history) whose
 * creator no longer has it, and deletes their bundles. It checks the whole
 * guild, because one role change can demote many users. The read sees the
 * uncommitted write of the transaction. Without such invites it is one query.
 * Publish the result with `publishInviteDeletes` after the commit.
 */
export async function revokeAdminInvitesOfNonAdmins(tx: Tx, guildId: string): Promise<RevokedInvite[]> {
  const rows = await tx
    .select({ id: invites.id, createdBy: invites.createdBy })
    .from(invites)
    .where(and(eq(invites.guildId, guildId), eq(invites.revoked, false), needsAdministratorSql()))
  if (rows.length === 0) return []
  const data = await drizzleMlsRepo(tx).getGuildPermissionData(guildId)
  if (!data) return []
  const hit = rows.filter((r) => !hasGuildPermission(data, r.createdBy, Permissions.ADMINISTRATOR))
  if (hit.length === 0) return []
  return drizzleInviteHistoryStore(tx).revokeInvites(hit.map((r) => r.id))
}

/** `INVITE_DELETE` → guild for each revoked invite. Call after the commit. */
export async function publishInviteDeletes(guildId: string, revoked: readonly RevokedInvite[]): Promise<void> {
  for (const r of revoked) {
    await publishToGuild(guildId, 'INVITE_DELETE', { guildId, code: r.code, inviteId: r.inviteId })
  }
}
