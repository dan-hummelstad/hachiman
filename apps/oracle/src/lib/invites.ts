/**
 * Guild invites (contract §4). A code is a public, non-consuming preview
 * (`GET /api/v1/invites/:code`, the `/invite/[code]` landing page) until an
 * authenticated user accepts it, which creates the membership and consumes
 * one use — idempotently for existing members.
 */
import { and, count, eq } from 'drizzle-orm'
import type { InvitePreview } from '@hachiman/client/types'

import { db } from '@/db/client'
import { guildMembers, guilds, invites, type InviteRow } from '@/db/schema'
import {
  InviteExhaustedError,
  InviteExpiredError,
  InviteRevokedError,
  NotFoundError,
} from '@/lib/errors'

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
 * concurrent accepts so `maxUses` can't be overshot.
 */
export async function acceptInvite(
  code: string,
  userId: string,
): Promise<{ guildId: string; joined: boolean }> {
  const normalized = normalizeCode(code)
  if (!normalized) throw new NotFoundError('Unknown invite')
  return await db.transaction(async (tx) => {
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
    await tx.insert(guildMembers).values({ guildId: invite.guildId, userId })
    await tx
      .update(invites)
      .set({ uses: invite.uses + 1 })
      .where(eq(invites.id, invite.id))
    return { guildId: invite.guildId, joined: true }
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
