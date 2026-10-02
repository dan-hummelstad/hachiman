/**
 * Signs every user out everywhere. Run it after you restore or copy a database,
 * or after a leak. A dev reset needs it only for the Redis cut-off: the reset
 * already deletes the users, and session-revocation.ts rejects their cookies.
 *
 * Invoked by `pnpm -F @hachiman/oracle sessions:revoke`.
 */
import { Redis } from 'ioredis'
import postgres from 'postgres'

import { SESSIONS_REVOKED_AT_KEY } from '../lib/session-revocation'

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  const redisUrl = process.env.REDIS_URL
  if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL must be set')

  const redis = new Redis(redisUrl)
  await redis.set(SESSIONS_REVOKED_AT_KEY, String(Date.now()))
  await redis.quit()
  console.log('[sessions] dashboard sessions revoked')

  // OIDC sessions, grants, codes and access/refresh tokens. Clients live in oidc_clients.
  const sql = postgres(databaseUrl, { max: 1 })
  const rows = await sql`DELETE FROM oidc_adapter_payloads`
  await sql.end()
  console.log(`[sessions] deleted ${rows.count} OIDC sessions, grants and tokens`)
}

main().catch((err) => {
  console.error('[sessions] revoke failed', err)
  process.exit(1)
})
