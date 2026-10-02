/**
 * Server-side auth helpers.
 *
 * Resolves the current actor from either path:
 *   1. Auth.js session cookie  — set by the dashboard sign-in flow
 *      (browser users hitting `/api/*` from the dashboard).
 *   2. OIDC access-token Bearer header — sent by the Hachiman desktop /
 *      browser clients, which PKCE-sign-in against our own panva `/api/oidc`
 *      and present the returned `access_token` as `Authorization: Bearer …`.
 *
 * Both paths return the same Session shape so callers can read
 * `session.user.{id,role,email}` without branching on which auth matched.
 *
 * Usage:
 *   import { requireUser } from '@/lib/auth-helpers'
 *   const session = await requireUser()   // throws if unauthenticated
 *   const admin = await requireAdmin()    // dashboard cookie + role admin only
 */
import { headers } from 'next/headers'
import { eq } from 'drizzle-orm'
import type { Session } from 'next-auth'

import { auth } from '@/auth'
import { db } from '@/db/client'
import { users } from '@/db/schema'
import { getOidcProvider } from './oidc-provider'

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message)
    this.name = 'UnauthorizedError'
  }
}

export class ForbiddenError extends Error {
  constructor(message = 'Forbidden') {
    super(message)
    this.name = 'ForbiddenError'
  }
}

export async function requireUser(): Promise<Session> {
  // `auth` from next-auth is overloaded (it's also a higher-order route
  // handler wrapper); calling it with no args returns `Session | null` —
  // narrow back to that shape explicitly so the bearer-fallback union
  // resolves cleanly.
  const cookieSession = (await auth()) as Session | null
  const session = cookieSession ?? (await sessionFromBearer())
  if (!session?.user?.id) {
    throw new UnauthorizedError()
  }
  return session
}

/**
 * The deployment admin API (`/api/admin`). Dashboard cookie only: a Bearer
 * token is held by the Hachiman app, and a token taken from there must not
 * give admin access. The jwt callback reads the role from the DB, so a
 * demotion applies at once.
 */
export async function requireAdmin(): Promise<Session> {
  const session = (await auth()) as Session | null
  if (!session?.user?.id) throw new UnauthorizedError()
  if (session.user.role !== 'admin') throw new ForbiddenError()
  return session
}

export async function getOptionalUser(): Promise<Session | null> {
  const cookieSession = (await auth()) as Session | null
  const session = cookieSession ?? (await sessionFromBearer())
  return session?.user?.id ? session : null
}

/**
 * Resolve an Auth.js-shaped session from an `Authorization: Bearer` header.
 * Returns null on any "not authenticated via Bearer" outcome — caller falls
 * through to UnauthorizedError. Looks the token up directly against the
 * in-process panva provider (no HTTP self-call to /token/introspection);
 * panva's `AccessToken.find` returns undefined for unknown/expired/revoked
 * tokens, which we surface as null here.
 */
async function sessionFromBearer(): Promise<Session | null> {
  const headerStore = await headers()
  const authHeader = headerStore.get('authorization')
  if (!authHeader) return null
  const match = /^bearer\s+(.+)$/i.exec(authHeader.trim())
  if (!match) return null
  const token = match[1].trim()
  if (!token) return null

  let provider
  try {
    provider = await getOidcProvider()
  } catch {
    return null
  }
  const accessToken = await provider.AccessToken.find(token)
  if (!accessToken?.accountId) return null

  const row = await db.query.users.findFirst({ where: eq(users.id, accessToken.accountId) })
  if (!row) return null

  // Build a Session-shaped object that matches what next-auth's `auth()`
  // returns. Callers only read `user.{id,role,email,name,image}`; `expires`
  // is required on the Session contract but not read by any route helper.
  const expSeconds =
    typeof accessToken.exp === 'number'
      ? accessToken.exp
      : Math.floor(Date.now() / 1000) + (accessToken.expiration ?? 0)
  return {
    user: {
      id: row.id,
      role: row.role,
      email: row.email,
      name: row.displayName,
      image: null,
    },
    expires: new Date(expSeconds * 1000).toISOString(),
  }
}
