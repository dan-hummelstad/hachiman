/**
 * Invite codes + signed `takusen://join#…` URIs.
 *
 * Invite codes are short, human-friendly tokens that, when redeemed, return a
 * signed join URI the Hachiman client decodes.
 *
 * Signature scheme (v1): HMAC-SHA256 with a shared secret env var
 * (TAKUSEN_INVITE_SIGNING_KEY). This is symmetric — anyone who can verify a
 * signature can also produce one, so the Hachiman client and Oracle must
 * share the secret out-of-band for v1. Upgrade path: Ed25519 with a public
 * key endpoint; see the agent report.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  inviteCodes,
  servers,
  type InviteCode,
  type Server,
} from '@/db/schema'
import { getServerById, type ServerWithVerification } from '@/lib/servers'

// ---------------------------------------------------------------------------
// Code generation — RFC 4648 base32, minus ambiguous {0, O, I, 1}.
// 8 chars -> ~32^8 ≈ 1.1e12 codes (plenty for the rate at which humans hand
// these out; the unique index on `code` catches the rare collision).
// ---------------------------------------------------------------------------

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

export function generateInviteCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) {
    out += CODE_ALPHABET[b % CODE_ALPHABET.length]
  }
  return out
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class InviteNotFoundError extends Error {
  constructor() {
    super('Invite not found')
    this.name = 'InviteNotFoundError'
  }
}
export class InviteExpiredError extends Error {
  constructor() {
    super('Invite expired')
    this.name = 'InviteExpiredError'
  }
}
export class InviteExhaustedError extends Error {
  constructor() {
    super('Invite has reached its maximum uses')
    this.name = 'InviteExhaustedError'
  }
}
export class InviteRevokedError extends Error {
  constructor() {
    super('Invite has been revoked')
    this.name = 'InviteRevokedError'
  }
}

// ---------------------------------------------------------------------------
// Create / redeem
// ---------------------------------------------------------------------------

export interface CreateInviteInput {
  serverId: string
  createdByUserId: string
  expiresAt?: Date | null
  maxUses?: number | null
}

export async function createInvite(input: CreateInviteInput): Promise<InviteCode> {
  // Retry on rare collisions of the unique `code` index.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode()
    try {
      const rows = await db
        .insert(inviteCodes)
        .values({
          serverId: input.serverId,
          code,
          createdByUserId: input.createdByUserId,
          expiresAt: input.expiresAt ?? null,
          maxUses: input.maxUses ?? null,
        })
        .returning()
      const row = rows[0]
      if (row) return row
    } catch (err) {
      // 23505 = unique_violation. Retry on collision; otherwise rethrow.
      const code23505 = (err as { code?: string }).code === '23505'
      if (!code23505 || attempt === 4) throw err
    }
  }
  throw new Error('Failed to allocate a unique invite code')
}

export interface RedeemedInvite {
  server: Server
  invite: InviteCode
}

export async function redeemInvite(code: string): Promise<RedeemedInvite> {
  // Re-fetch + update in a transaction so use-count increments are atomic.
  return await db.transaction(async (tx) => {
    const inviteRows = await tx
      .select()
      .from(inviteCodes)
      .where(eq(inviteCodes.code, code))
      .for('update')
      .limit(1)
    const invite = inviteRows[0]
    if (!invite) throw new InviteNotFoundError()
    if (invite.revoked) throw new InviteRevokedError()
    if (invite.expiresAt && invite.expiresAt.getTime() <= Date.now()) {
      throw new InviteExpiredError()
    }
    if (invite.maxUses !== null && invite.useCount >= invite.maxUses) {
      throw new InviteExhaustedError()
    }

    await tx
      .update(inviteCodes)
      .set({ useCount: invite.useCount + 1 })
      .where(eq(inviteCodes.id, invite.id))

    const serverRows = await tx
      .select()
      .from(servers)
      .where(eq(servers.id, invite.serverId))
      .limit(1)
    const server = serverRows[0]
    if (!server) {
      throw new InviteNotFoundError()
    }
    return { server, invite: { ...invite, useCount: invite.useCount + 1 } }
  })
}

export async function revokeInvite(inviteId: string, serverId: string): Promise<void> {
  const rows = await db
    .update(inviteCodes)
    .set({ revoked: true })
    .where(and(eq(inviteCodes.id, inviteId), eq(inviteCodes.serverId, serverId)))
    .returning({ id: inviteCodes.id })
  if (rows.length === 0) {
    throw new InviteNotFoundError()
  }
}

export async function getInviteByCode(code: string): Promise<InviteCode | null> {
  const rows = await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1)
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Join-URI signing
// ---------------------------------------------------------------------------

export interface JoinPayload {
  v: 1
  host: string
  port: number
  name: string
  slug: string
  verifiedAt: string | null
}

export interface SignedJoinPayload extends JoinPayload {
  sig: string
}

function getSigningKey(): string {
  const key = process.env.TAKUSEN_INVITE_SIGNING_KEY
  if (!key || key.length < 32) {
    throw new Error(
      'TAKUSEN_INVITE_SIGNING_KEY is not set (or is shorter than 32 chars)',
    )
  }
  return key
}

/**
 * Canonical JSON for HMAC: keys sorted alphabetically, no whitespace, no `sig`
 * field. This is the only representation both sides agree to hash.
 */
export function canonicalizeJoinPayload(payload: JoinPayload): string {
  const ordered = {
    host: payload.host,
    name: payload.name,
    port: payload.port,
    slug: payload.slug,
    v: payload.v,
    verifiedAt: payload.verifiedAt,
  }
  return JSON.stringify(ordered)
}

export function signJoinPayload(payload: JoinPayload): SignedJoinPayload {
  const key = getSigningKey()
  const canonical = canonicalizeJoinPayload(payload)
  const sig = createHmac('sha256', key).update(canonical).digest('hex')
  return { ...payload, sig }
}

export function verifyJoinPayload(payload: SignedJoinPayload): boolean {
  const { sig, ...rest } = payload
  const expected = createHmac('sha256', getSigningKey())
    .update(canonicalizeJoinPayload(rest))
    .digest('hex')
  if (expected.length !== sig.length) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(sig, 'hex'))
}

export function buildJoinUri(server: Pick<ServerWithVerification, 'host' | 'port' | 'name' | 'slug' | 'verifiedAt'>): string {
  const payload: JoinPayload = {
    v: 1,
    host: server.host,
    port: server.port,
    name: server.name,
    slug: server.slug,
    verifiedAt: server.verifiedAt ? server.verifiedAt.toISOString() : null,
  }
  const signed = signJoinPayload(payload)
  const encoded = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url')
  return `takusen://join#${encoded}`
}

/**
 * Convenience: redeems the code and returns the signed URI plus the server
 * row. Throws on missing/expired/exhausted/revoked.
 */
export async function redeemInviteToUri(code: string): Promise<{
  joinUri: string
  server: ServerWithVerification
  invite: InviteCode
}> {
  const { server: serverRow, invite } = await redeemInvite(code)
  // Re-fetch with verifiedAt so the signed payload knows the trust level.
  const server = await getServerById(serverRow.id)
  if (!server) throw new InviteNotFoundError()
  const joinUri = buildJoinUri(server)
  return { joinUri, server, invite }
}
