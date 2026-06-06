/**
 * Domain verification via DNS TXT records.
 *
 * Flow:
 *  1. Owner clicks "Verify domain" -> startDomainVerification() inserts a
 *     verification row with a random `txtToken` and returns it.
 *  2. UI shows: publish a TXT record at `takusen._verify.<domain>` with the
 *     token as the value. The two-label format mirrors DKIM's
 *     `<selector>._domainkey.<domain>` convention so DNS providers' web UIs
 *     handle it predictably.
 *  3. Owner clicks "Check now" -> checkDomainVerification() resolves the TXT
 *     records and compares each to the stored token. Updates `verifiedAt` on
 *     match.
 */
import { promises as dns } from 'node:dns'
import { desc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { serverDomainVerifications, type ServerDomainVerification } from '@/db/schema'

const VERIFICATION_LABEL = 'takusen._verify'

export function dnsVerificationHostname(domain: string): string {
  return `${VERIFICATION_LABEL}.${domain}`
}

// ---------------------------------------------------------------------------
// Token generation — 32 chars from an unambiguous base32-ish alphabet.
// ---------------------------------------------------------------------------

const TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const TOKEN_LENGTH = 32

export function generateTxtToken(): string {
  const bytes = new Uint8Array(TOKEN_LENGTH)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) {
    out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length]
  }
  return `takusen-verify=${out}`
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function startDomainVerification(
  serverId: string,
  domain: string,
): Promise<ServerDomainVerification> {
  const token = generateTxtToken()
  const rows = await db
    .insert(serverDomainVerifications)
    .values({
      virtualServerId: serverId,
      domain,
      txtToken: token,
    })
    .returning()
  const row = rows[0]
  if (!row) {
    throw new Error('Failed to insert verification row')
  }
  return row
}

export async function getActiveVerification(
  serverId: string,
): Promise<ServerDomainVerification | null> {
  const rows = await db
    .select()
    .from(serverDomainVerifications)
    .where(eq(serverDomainVerifications.virtualServerId, serverId))
    .orderBy(desc(serverDomainVerifications.createdAt))
    .limit(1)
  return rows[0] ?? null
}

export async function getVerificationById(
  id: string,
): Promise<ServerDomainVerification | null> {
  const rows = await db
    .select()
    .from(serverDomainVerifications)
    .where(eq(serverDomainVerifications.id, id))
    .limit(1)
  return rows[0] ?? null
}

export interface CheckResult {
  verified: boolean
  records: string[]
  error?: string
  lastCheckedAt: Date
}

export async function checkDomainVerification(
  verificationId: string,
): Promise<CheckResult> {
  const row = await getVerificationById(verificationId)
  if (!row) {
    throw new Error('Verification not found')
  }
  const hostname = dnsVerificationHostname(row.domain)
  const now = new Date()

  let records: string[] = []
  let error: string | undefined
  try {
    // resolveTxt returns string[][] where each inner array is one TXT record
    // possibly split into multiple strings. Join inner strings per record.
    const raw = await dns.resolveTxt(hostname)
    records = raw.map((parts) => parts.join(''))
  } catch (err) {
    console.log(err)
    error =
      err instanceof Error
        ? `${err.name}: ${err.message}`
        : 'Unknown DNS error'
  }

  const verified = records.some((r) => r.trim() === row.txtToken)

  await db
    .update(serverDomainVerifications)
    .set({
      lastCheckedAt: now,
      verifiedAt: verified ? row.verifiedAt ?? now : row.verifiedAt,
    })
    .where(eq(serverDomainVerifications.id, verificationId))

  return { verified, records, error, lastCheckedAt: now }
}
