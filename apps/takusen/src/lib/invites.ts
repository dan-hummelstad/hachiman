/**
 * Guild invites (contract §4). A code is a public, non-consuming preview
 * (`GET /api/v1/invites/:code`, the `/invite/[code]` landing page) until an
 * authenticated user accepts it, which creates the membership and consumes
 * one use — idempotently for existing members.
 */
import { and, count, eq } from 'drizzle-orm'
import type { InvitePreview } from '@hachiman/client/types'

import { db, type Database } from '@/db/client'
import { guildMembers, guilds, invites, type InviteRow } from '@/db/schema'
import {
  InviteExhaustedError,
  InviteExpiredError,
  InviteRevokedError,
  MissingPermissionsError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
import { membershipChanged, membershipTransaction, MembershipTriggers } from '@/lib/guilds'
import { drizzleInviteHistoryStore } from '@/lib/invite-history'
import { creatorsWithoutAdmin } from '@/lib/invite-limits'
import { drizzleMlsRepo } from '@/lib/mls/repo.drizzle'

// RFC 4648 base32 minus the ambiguous {0, O, I, 1}. 8 chars ≈ 1.1e12 codes;
// the unique index on `code` catches the rare collision (createInvite retries).
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8
const CODE_RE = /^[A-Z2-9]{8}$/

export function generateInviteCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  return out
}

/** Codes are uppercase; accept what a user retyped in lowercase. */
function normalizeCode(code: string): string | null {
  const upper = code.trim().toUpperCase()
  return CODE_RE.test(upper) ? upper : null
}

function assertUsable(invite: InviteRow): void {
  if (invite.revoked) throw new InviteRevokedError()
  if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) throw new InviteExpiredError()
  if (invite.maxUses !== null && invite.uses >= invite.maxUses) throw new InviteExhaustedError()
}

export async function getInviteByCode(code: string): Promise<InviteRow | null> {
  const normalized = normalizeCode(code)
  if (!normalized) return null
  const [row] = await db.select().from(invites).where(eq(invites.code, normalized)).limit(1)
  return row ?? null
}

/** Throws NotFound / InviteExpired / InviteRevoked / InviteExhausted. */
export async function previewInvite(code: string): Promise<InvitePreview> {
  const invite = await getInviteByCode(code)
  if (!invite) throw new NotFoundError('Unknown invite')
  assertUsable(invite)
  const [[guild], [{ n }]] = await Promise.all([
    db
      .select({ id: guilds.id, name: guilds.name, icon: guilds.icon })
      .from(guilds)
      .where(eq(guilds.id, invite.guildId))
      .limit(1),
    db.select({ n: count() }).from(guildMembers).where(eq(guildMembers.guildId, invite.guildId)),
  ])
  if (!guild) throw new NotFoundError('Unknown invite')
  return {
    code: invite.code,
    guild,
    memberCount: n,
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    hasHistory: invite.record !== null,
  }
}

/** For the `/invite/[code]` page: null when the invite is unknown or no longer usable. */
export async function getInvitePreview(code: string): Promise<InvitePreview | null> {
  try {
    return await previewInvite(code)
  } catch (err) {
    if (
      err instanceof NotFoundError ||
      err instanceof InviteExpiredError ||
      err instanceof InviteRevokedError ||
      err instanceof InviteExhaustedError
    ) {
      return null
    }
    throw err
  }
}

/**
 * Join the invite's guild. Existing members get `joined: false` and consume
 * no use (even if the invite has since expired). The row lock serialises
 * concurrent accepts so `maxUses` can't be overshot. The membership row names
 * the invite, and the last use sets `exhausted_at` (§12.11.4). A join tells
 * the DS in the same transaction (`guild_member_added`, §12.18).
 */
export async function acceptInvite(
  code: string,
  userId: string,
  actorDeviceId: string | null,
): Promise<{ guildId: string; joined: boolean }> {
  const normalized = normalizeCode(code)
  if (!normalized) throw new NotFoundError('Unknown invite')
  return await membershipTransaction(async (tx) => {
    const [invite] = await tx
      .select()
      .from(invites)
      .where(eq(invites.code, normalized))
      .for('update')
    if (!invite) throw new NotFoundError('Unknown invite')
    const [existing] = await tx
      .select({ userId: guildMembers.userId })
      .from(guildMembers)
      .where(and(eq(guildMembers.guildId, invite.guildId), eq(guildMembers.userId, userId)))
    if (existing) return { guildId: invite.guildId, joined: false }
    assertUsable(invite)
    await drizzleInviteHistoryStore(tx).joinWithInvite(invite, userId, new Date())
    await membershipChanged(tx, MembershipTriggers.memberJoined(invite.guildId, userId), actorDeviceId)
    return { guildId: invite.guildId, joined: true }
  })
}

/**
 * An invite that needs ADMINISTRATOR: a permanent invite (contract §4 "Invite
 * limits"), or an invite with history (§12.11.4) with its record and key id.
 * The transaction holds the guild row and the creator's membership row FOR
 * SHARE, and checks ADMINISTRATOR again inside it. A role or member-role
 * change locks the guild row FOR UPDATE, and a removal deletes the membership
 * row. Thus a concurrent demotion either comes first (403 here) or waits and
 * then revokes this invite. A key id that another invite has gives 400.
 */
export async function createAdminInvite(
  opts: {
    guildId: string
    createdBy: string
    expiresAt: Date | null
    maxUses: number | null
    history?: { record: Uint8Array; keyId: Uint8Array } | undefined
  },
  database: Database = db,
): Promise<InviteRow> {
  const { history, ...values } = opts
  return database.transaction(async (tx) => {
    await tx.select({ id: guilds.id }).from(guilds).where(eq(guilds.id, opts.guildId)).for('share')
    const [member] = await tx
      .select({ userId: guildMembers.userId })
      .from(guildMembers)
      .where(and(eq(guildMembers.guildId, opts.guildId), eq(guildMembers.userId, opts.createdBy)))
      .for('share')
    const data = member ? await drizzleMlsRepo(tx).getGuildPermissionData(opts.guildId) : null
    if (!data || creatorsWithoutAdmin(data, [opts.createdBy]).size > 0) {
      throw new MissingPermissionsError('Only an administrator can make this invite')
    }
    // A unique violation would abort the transaction: skip the conflict, then retry a code collision.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [row] = await tx
        .insert(invites)
        .values({ ...values, ...history, code: generateInviteCode() })
        .onConflictDoNothing()
        .returning()
      if (row) return row
      if (history) {
        const [taken] = await tx.select({ id: invites.id }).from(invites).where(eq(invites.keyId, history.keyId)).limit(1)
        if (taken) throw new ValidationError('Another invite has this key id')
      }
    }
    throw new Error('Could not allocate an invite code')
  })
}

export async function createInvite(opts: {
  guildId: string
  createdBy: string
  expiresAt: Date | null
  maxUses: number | null
}): Promise<InviteRow> {
  for (let attempt = 0; ; attempt++) {
    try {
      const [row] = await db
        .insert(invites)
        .values({ ...opts, code: generateInviteCode() })
        .returning()
      return row
    } catch (err) {
      // 23505 unique_violation: code collision — retry with a fresh code.
      if ((err as { code?: string }).code !== '23505' || attempt >= 2) throw err
    }
  }
}
