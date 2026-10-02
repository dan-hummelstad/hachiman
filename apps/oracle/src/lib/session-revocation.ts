/**
 * Auth.js sessions are stateless JWT cookies, so a DB reset or a leaked cookie
 * would otherwise keep a browser signed in as a user that no longer exists.
 * Every auth() call checks the token against the DB and a global cut-off.
 * Revoke everything with `pnpm -F @hachiman/oracle sessions:revoke`.
 */
import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { users } from '@/db/schema'
import { redis } from '@/lib/events'

/** Unix ms. Tokens issued before it are dead. Shared with scripts/revoke-sessions.ts. */
export const SESSIONS_REVOKED_AT_KEY = 'oracle:sessions_revoked_at'

export async function isSessionLive(userId: string, authTime: number): Promise<boolean> {
  const [row, revokedAt] = await Promise.all([
    db.query.users.findFirst({ columns: { id: true }, where: eq(users.id, userId) }),
    redis().get(SESSIONS_REVOKED_AT_KEY),
  ])
  return row !== undefined && authTime >= Number(revokedAt ?? 0)
}
