/**
 * POST /api/admin/users/:id/reset-keys — 204. The DS half of a password reset
 * (§12.4 "Password reset"): every device of the user is revoked and the master
 * key is superseded, and the user is signed out. The account stays.
 *
 * For a user who has no device to link from and no recovery key: the next
 * sign-in offers "Restore with recovery key" and "Reset my keys".
 */
import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { users } from '@/db/schema'
import { adminRoute, noContent } from '@/lib/api-helpers'
import { NotFoundError } from '@/lib/errors'
import { membershipChanged, membershipTransaction, MembershipTriggers } from '@/lib/guilds'
import { assertId } from '@/lib/ids'
import { revokeUserSessions } from '@/lib/session-revocation'

export const POST = adminRoute<{ id: string }>(async ({ params }) => {
  const id = assertId(params.id, 'user')
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1)
  if (!row) throw new NotFoundError('Unknown user')
  await membershipTransaction((tx) => membershipChanged(tx, MembershipTriggers.passwordReset(id), null))
  await revokeUserSessions(id)
  return noContent()
})
