/**
 * Password reset token helpers.
 *
 * Tokens are presented to the user as URL-safe base64 random strings; we only
 * persist the SHA-256 hash, so a database leak can't be turned into account
 * takeovers. Tokens expire after `RESET_TOKEN_TTL_MS`.
 */
import { randomBytes, createHash } from 'node:crypto'

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
