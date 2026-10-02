/**
 * Auth.js sessions are stateless JWT cookies, so a DB reset or a leaked cookie
 * would otherwise keep a browser signed in as a user that no longer exists.
 * Every auth() call checks the token against the DB, a global cut-off and a
 * per-user cut-off, and refreshes the role claim from the DB.
 *
 * Revoke everything with `pnpm -F @hachiman/takusen sessions:revoke` or
 * POST /api/admin/sessions/revoke-all; one user with
 * POST /api/admin/users/:id/sign-out.
 */
import { eq, or, sql } from 'drizzle-orm'

import { db, type Tx } from '@/db/client'
import { oidcAdapterPayloads, users } from '@/db/schema'
import { redis } from '@/lib/events'

/** Unix ms. Tokens issued before it are dead. */
export const SESSIONS_REVOKED_AT_KEY = 'takusen:sessions_revoked_at'

/** Unix ms. This user's tokens issued before it are dead. No TTL: `authTime` survives cookie refreshes. */
export function userSessionsRevokedAtKey(userId: string): string {
  return `${SESSIONS_REVOKED_AT_KEY}:${userId}`
}

/** The user's current role while the session is valid, else null (the caller clears the cookie). */
export async function liveSessionRole(
  userId: string,
  authTime: number,
): Promise<'user' | 'admin' | null> {
  const [row, [all, mine]] = await Promise.all([
    db.query.users.findFirst({ columns: { role: true }, where: eq(users.id, userId) }),
    redis().mget(SESSIONS_REVOKED_AT_KEY, userSessionsRevokedAtKey(userId)),
  ])
  if (!row || authTime < Math.max(Number(all ?? 0), Number(mine ?? 0))) return null
  return row.role
}

/**
 * Signs one user out everywhere: kills their dashboard cookies and deletes
 * their OIDC sessions, grants, codes and access/refresh tokens. Returns the
 * number of OIDC rows deleted.
 */
export async function revokeUserSessions(userId: string): Promise<number> {
  await redis().set(userSessionsRevokedAtKey(userId), String(Date.now()))
  return await deleteUserOidcRows(db, userId)
}

/** The user's OIDC sessions, grants, codes and tokens: rows with its accountId, and every row of those grants. */
export async function deleteUserOidcRows(executor: typeof db | Tx, userId: string): Promise<number> {
  const ofUser = sql`${oidcAdapterPayloads.payload}->>'accountId' = ${userId}`
  const rows = await executor
    .delete(oidcAdapterPayloads)
    .where(
      or(
        ofUser,
        sql`${oidcAdapterPayloads.grantId} IN (SELECT ${oidcAdapterPayloads.grantId} FROM ${oidcAdapterPayloads} WHERE ${ofUser} AND ${oidcAdapterPayloads.grantId} IS NOT NULL)`,
      ),
    )
    .returning({ id: oidcAdapterPayloads.id })
  return rows.length
}

/** Signs every user out everywhere (the caller too). Returns the number of OIDC rows deleted. */
export async function revokeAllSessions(): Promise<number> {
  await redis().set(SESSIONS_REVOKED_AT_KEY, String(Date.now()))
  // OIDC sessions, grants, codes and access/refresh tokens. Clients live in oidc_clients.
  const rows = await db.delete(oidcAdapterPayloads).returning({ id: oidcAdapterPayloads.id })
  return rows.length
}
