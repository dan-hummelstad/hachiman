/**
 * Signs every user out everywhere. Run it after you restore or copy a database,
 * or after a leak. A dev reset needs it only for the Redis cut-off: the reset
 * already deletes the users, and session-revocation.ts rejects their cookies.
 *
 * Invoked by `pnpm -F @hachiman/takusen sessions:revoke`. The admin API runs
 * the same function (POST /api/admin/sessions/revoke-all).
 */
import { revokeAllSessions } from '../lib/session-revocation'

revokeAllSessions()
  .then((count) => {
    console.log(`[sessions] dashboard sessions revoked; deleted ${count} OIDC sessions, grants and tokens`)
    process.exit(0)
  })
  .catch((err) => {
    console.error('[sessions] revoke failed', err)
    process.exit(1)
  })
