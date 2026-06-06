/**
 * Invite codes + signed join URIs.
 *
 * Invite codes are short, human-friendly tokens that, when redeemed, return a
 * signed join URI the Hachiman client decodes. The URI is an `https://` link
 * to the Oracle's `/join` page with the signed payload encoded in the URL
 * hash — that means the hash never leaves the browser (no Oracle-side log of
 * who joined which server) AND the URL is paste-anywhere (chat apps, email,
 * social previews all handle https). Recipients without the Hachiman app
 * land on `/join`, which offers an "Open in app" deep-link (via the legacy
 * `takusen://join#…` scheme, still registered on Electron) and an
 * "Open in browser" fallback.
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
import { inviteCodes, type InviteCode } from '@/db/schema'
import {
  getServerById,
  type Server,
  type ServerWithVerification,
} from '@/lib/servers'

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
          virtualServerId: input.serverId,
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

    // Resolve the server via the unified Server view in lib/servers.ts —
    // we need identity (name/slug) AND placement (host/port) to render
    // the invite redemption + return payload. Reading inside the same tx
    // would require duplicating the join here; an outside read is fine
    // because invite redemption isn't conflict-sensitive past the
    // use-count increment above.
    return { virtualServerId: invite.virtualServerId, invite: { ...invite, useCount: invite.useCount + 1 } }
  }).then(async ({ virtualServerId, invite }) => {
    const server = await getServerById(virtualServerId)
    if (!server) throw new InviteNotFoundError()
    return { server, invite }
  })
}

export async function revokeInvite(inviteId: string, serverId: string): Promise<void> {
  const rows = await db
    .update(inviteCodes)
    .set({ revoked: true })
    .where(and(eq(inviteCodes.id, inviteId), eq(inviteCodes.virtualServerId, serverId)))
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
  /**
   * Oracle's UUID for this server. The Hachiman client needs it to mint a
   * per-server OIDC access token before connecting (see
   * apps/hachiman/src/services/ServersService.ts `resolveOracleToken`); a
   * payload without it forces the client to either re-look-it-up or refuse.
   * Included in the canonical HMAC input so a tamper-modified id is rejected.
   */
  serverId: string
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
    serverId: payload.serverId,
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

/**
 * Origin (scheme + host + port, no path) of the Oracle web app. Derived from
 * `OIDC_ISSUER_URL` so we don't introduce a second env to keep in sync —
 * a deployment that has working OIDC has, by definition, a public Oracle URL.
 *
 * Falls back to a hardcoded localhost dev origin if the env is unset, so
 * unit tests / local CI without an `.env` file don't blow up — production
 * code paths always have OIDC_ISSUER_URL set.
 */
function getOracleOrigin(): string {
  const issuer = process.env.OIDC_ISSUER_URL?.trim()
  if (!issuer) return 'http://localhost:3000'
  try {
    return new URL(issuer).origin
  } catch {
    return 'http://localhost:3000'
  }
}

export function buildJoinUri(server: Pick<ServerWithVerification, 'id' | 'host' | 'port' | 'name' | 'slug' | 'verifiedAt'>): string {
  const payload: JoinPayload = {
    v: 1,
    serverId: server.id,
    host: server.host,
    port: server.port,
    name: server.name,
    slug: server.slug,
    verifiedAt: server.verifiedAt ? server.verifiedAt.toISOString() : null,
  }
  const signed = signJoinPayload(payload)
  const encoded = Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url')
  // https URL pointing at the Oracle's /join page. The payload travels in
  // the fragment so it never reaches the Oracle server (fragments are
  // client-only); the /join page reads it client-side, attempts the
  // `takusen://join#…` deep link to wake an installed Hachiman, and falls
  // back to opening the in-browser client at the same hash.
  return `${getOracleOrigin()}/join#${encoded}`
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
