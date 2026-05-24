/**
 * JoinUriService — parse and verify `takusen://join#<base64url>` URIs.
 *
 * URI format (mirrors `apps/oracle/src/lib/invite-signing.ts`):
 *   takusen://join#<base64url(JSON.stringify({
 *     v: 1, host, port, name, slug, verifiedAt: ISO|null, sig: <hex hmac>
 *   }))>
 *
 * HMAC-SHA256 over `canonicalizeJoinPayload(payloadMinusSig)` using the
 * shared TAKUSEN_INVITE_SIGNING_KEY. The renderer doesn't have Node's
 * `crypto.createHmac`, so we use WebCrypto. The signing key must be exposed
 * at build time via VITE_TAKUSEN_INVITE_SIGNING_KEY (same value as the
 * Oracle's env var) so HMAC verification produces a matching digest.
 *
 * The browser fallback `/join#<payload>` path uses the same parser — the URL
 * hash is read directly and passed to `parseAndVerifyHash`.
 */

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

export type JoinUriParseResult =
  | { ok: true; payload: SignedJoinPayload; verified: boolean }
  | { ok: false; reason: string }

const TAKUSEN_SCHEME = 'takusen:'
const TAKUSEN_HOST = 'join'

/**
 * Canonical JSON for HMAC: keys sorted alphabetically, no whitespace, no
 * `sig` field. MUST match `canonicalizeJoinPayload` in invite-signing.ts on
 * the Oracle side.
 */
export function canonicalizeJoinPayload(payload: JoinPayload): string {
  const ordered = {
    host: payload.host,
    name: payload.name,
    port: payload.port,
    slug: payload.slug,
    v: payload.v,
    verifiedAt: payload.verifiedAt
  }
  return JSON.stringify(ordered)
}

/**
 * Parse the URI shell and return the raw hash fragment, or null if this
 * isn't a valid takusen://join URI.
 */
function extractHash(uri: string): string | null {
  // `URL` is happy to parse `takusen://join#…` in all modern engines.
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }
  if (url.protocol !== TAKUSEN_SCHEME) return null
  // `new URL('takusen://join#foo').hostname` is 'join'; `pathname` is empty.
  if (url.hostname !== TAKUSEN_HOST) return null
  // url.hash includes the leading '#'.
  if (!url.hash || url.hash.length <= 1) return null
  return url.hash.slice(1)
}

function base64UrlDecodeToString(s: string): string | null {
  // base64url -> base64 padding fix-up.
  const padded = s.replace(/-/g, '+').replace(/_/g, '/')
  const padding = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4))
  try {
    const binary = atob(padded + padding)
    // Treat the binary string as UTF-8 bytes.
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

function isSignedJoinPayload(value: unknown): value is SignedJoinPayload {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    v.v === 1 &&
    typeof v.host === 'string' &&
    typeof v.port === 'number' &&
    typeof v.name === 'string' &&
    typeof v.slug === 'string' &&
    (v.verifiedAt === null || typeof v.verifiedAt === 'string') &&
    typeof v.sig === 'string'
  )
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(hex.substr(i * 2, 2), 16)
    if (Number.isNaN(byte)) return null
    out[i] = byte
  }
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, '0')
  }
  return s
}

/**
 * Constant-time equality of two equally-sized byte arrays. JS doesn't expose
 * Node's `timingSafeEqual` to the renderer, so we implement a minimal
 * fixed-time XOR comparison.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

function getSigningKey(): string | null {
  // Vite-style build-time inlining. The shared lib has no Vite types; both
  // host apps DO (electron-vite + vite), and they include this file in their
  // tsconfigs, so `import.meta.env` resolves with their type defs. We guard
  // with `typeof` so an environment without `import.meta.env` (e.g. tests)
  // simply returns null and verification fails closed.
  const env =
    typeof import.meta !== 'undefined' && import.meta && 'env' in import.meta
      ? (import.meta.env as Record<string, string | undefined> | undefined)
      : undefined
  const key = env?.VITE_TAKUSEN_INVITE_SIGNING_KEY
  if (!key || key.length < 32) return null
  return key
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  const keyBytes = new TextEncoder().encode(secret)
  return crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ])
}

/**
 * Verify the HMAC on a parsed payload. Returns false (rather than throwing)
 * if the signing key isn't available — callers can decide whether to surface
 * an "unverified" warning or refuse the URI outright.
 */
export async function verifyJoinPayload(payload: SignedJoinPayload): Promise<boolean> {
  const secret = getSigningKey()
  if (!secret) return false

  const sigBytes = hexToBytes(payload.sig)
  if (!sigBytes) return false

  // Drop `sig` for the canonical-JSON input — keys must match
  // `canonicalizeJoinPayload` on the Oracle side, which never includes it.
  const rest: JoinPayload = {
    v: payload.v,
    host: payload.host,
    port: payload.port,
    name: payload.name,
    slug: payload.slug,
    verifiedAt: payload.verifiedAt
  }
  const canonical = canonicalizeJoinPayload(rest)
  const key = await importHmacKey(secret)
  const macBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))
  const macBytes = new Uint8Array(macBuf)
  // Compare hex of both to match the Oracle side which stores hex.
  const expectedHex = bytesToHex(macBytes)
  const actualHex = payload.sig.toLowerCase()
  if (expectedHex.length !== actualHex.length) return false
  // Convert to bytes for a constant-time comparison.
  const expectedBytes = hexToBytes(expectedHex)
  const actualBytes = hexToBytes(actualHex)
  if (!expectedBytes || !actualBytes) return false
  return constantTimeEqual(expectedBytes, actualBytes)
}

/**
 * Parse a raw hash fragment (no leading '#') into a verified payload. Used
 * by both the takusen:// URI path and the browser /join#... fallback.
 */
export async function parseAndVerifyHash(hash: string): Promise<JoinUriParseResult> {
  if (!hash) return { ok: false, reason: 'Empty payload' }
  const json = base64UrlDecodeToString(hash)
  if (json === null) return { ok: false, reason: 'Malformed base64url payload' }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { ok: false, reason: 'Payload is not valid JSON' }
  }
  if (!isSignedJoinPayload(parsed)) {
    return { ok: false, reason: 'Payload does not match the v1 join shape' }
  }
  const verified = await verifyJoinPayload(parsed)
  return { ok: true, payload: parsed, verified }
}

/**
 * Parse a full `takusen://join#…` URI. Returns `{ ok: false }` if the scheme
 * is wrong or the hash is missing.
 */
export async function parseTakusenUri(uri: string): Promise<JoinUriParseResult> {
  const hash = extractHash(uri)
  if (hash === null) {
    return { ok: false, reason: 'Not a takusen://join URI' }
  }
  return parseAndVerifyHash(hash)
}

/**
 * Read the current `window.location.hash` (without leading '#') and parse
 * it, IF the current path matches `/join`. Used by the browser host to pick
 * up deep-link fallback navigations.
 */
export async function parseLocationHashIfJoin(): Promise<JoinUriParseResult | null> {
  if (typeof window === 'undefined') return null
  const path = window.location.pathname.replace(/\/+$/, '')
  if (path !== '/join') return null
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash
  if (!hash) return null
  return parseAndVerifyHash(hash)
}

export const joinUriService = {
  canonicalizeJoinPayload,
  verifyJoinPayload,
  parseAndVerifyHash,
  parseTakusenUri,
  parseLocationHashIfJoin
}

export type JoinUriService = typeof joinUriService
