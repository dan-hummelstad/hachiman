/**
 * Password reset token helpers, and the two password flows (§12.4, §12.18).
 *
 * Tokens are presented to the user as URL-safe base64 random strings; we only
 * persist the SHA-256 hash, so a database leak can't be turned into account
 * takeovers. Tokens expire after `RESET_TOKEN_TTL_MS`.
 *
 * A reset revokes every session and every device of the user. The DS change
 * (`devices_revoked` 'all', reason password_reset) also supersedes the current
 * master key, so a bearer token alone cannot replace it. A password change
 * revokes only the other sessions and keeps the devices.
 */
import { randomBytes, createHash } from 'node:crypto'

import { and, eq, gt } from 'drizzle-orm'

import { db, type Tx } from '@/db/client'
import { passwordResetTokens, users } from '@/db/schema'
import { membershipChanged, MembershipTriggers, wakeAfterCommit, type MembershipChange } from '@/lib/guilds'
import { revokeUserSessions } from '@/lib/session-revocation'

export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour

export function generateResetToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function buildResetUrl(baseUrl: string, token: string): string {
  const url = new URL('/reset-password', baseUrl)
  url.searchParams.set('token', token)
  return url.toString()
}

// MARK: - Reset

export interface PasswordResetPorts<X> {
  transaction<T>(fn: (tx: X) => Promise<T>): Promise<T>
  /** Deletes the token row when it is not expired. Returns its user, or null. One use only. */
  consumeToken(tx: X, tokenHash: string, now: Date): Promise<string | null>
  setPassword(tx: X, userId: string, passwordHash: string, now: Date): Promise<void>
  /** The DS seam, in the transaction. */
  membership(tx: X, change: MembershipChange): Promise<void>
  /** After the commit: the DS events and the scheduler wakeup. */
  afterCommit(tx: X): Promise<void>
  /** After the commit: every dashboard cookie and OIDC token of the user. */
  revokeSessions(userId: string): Promise<void>
}

/** Returns the user whose password changed, or null for a bad or expired token. */
export async function completePasswordReset<X>(
  ports: PasswordResetPorts<X>,
  input: { tokenHash: string; passwordHash: string; now: Date },
): Promise<string | null> {
  let handle: X | undefined
  const userId = await ports.transaction(async (tx) => {
    handle = tx
    const owner = await ports.consumeToken(tx, input.tokenHash, input.now)
    if (!owner) return null
    await ports.setPassword(tx, owner, input.passwordHash, input.now)
    await ports.membership(tx, MembershipTriggers.passwordReset(owner))
    return owner
  })
  if (!userId) return null
  await ports.afterCommit(handle as X)
  await ports.revokeSessions(userId)
  return userId
}

export const drizzlePasswordResetPorts: PasswordResetPorts<Tx> = {
  transaction: (fn) => db.transaction(fn),
  async consumeToken(tx, tokenHash, now) {
    const [row] = await tx
      .delete(passwordResetTokens)
      .where(and(eq(passwordResetTokens.tokenHash, tokenHash), gt(passwordResetTokens.expiresAt, now)))
      .returning({ userId: passwordResetTokens.userId })
    return row?.userId ?? null
  },
  async setPassword(tx, userId, passwordHash, now) {
    await tx.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, userId))
  },
  membership: (tx, change) => membershipChanged(tx, change, null),
  afterCommit: (tx) => wakeAfterCommit(tx),
  async revokeSessions(userId) {
    await revokeUserSessions(userId)
  },
}

// MARK: - Change

export interface PasswordChangePorts {
  setPassword(userId: string, passwordHash: string): Promise<void>
  /** Every dashboard cookie and OIDC token of the user, the current cookie included. */
  revokeSessions(userId: string): Promise<void>
  /** Issues a new cookie for the current browser, after the cut-off. */
  keepCurrentSession(): Promise<void>
}

/** A password change keeps the devices: it has no DS change. */
export async function completePasswordChange(ports: PasswordChangePorts, input: { userId: string; passwordHash: string }): Promise<void> {
  await ports.setPassword(input.userId, input.passwordHash)
  await ports.revokeSessions(input.userId)
  await ports.keepCurrentSession()
}
