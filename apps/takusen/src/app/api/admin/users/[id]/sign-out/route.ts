/**
 * POST /api/admin/users/:id/sign-out — 204. Ends the user's dashboard cookies
 * and deletes its OIDC sessions, grants and tokens (lib/session-revocation.ts).
 */
import { eq } from 'drizzle-orm'

import { db } from '@/db/client'
import { users } from '@/db/schema'
import { adminRoute, noContent } from '@/lib/api-helpers'
import { NotFoundError } from '@/lib/errors'
import { assertId } from '@/lib/ids'
import { revokeUserSessions } from '@/lib/session-revocation'

export const POST = adminRoute<{ id: string }>(async ({ params }) => {
  const id = assertId(params.id, 'user')
  const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1)
  if (!row) throw new NotFoundError('Unknown user')
  await revokeUserSessions(id)
  return noContent()
})
