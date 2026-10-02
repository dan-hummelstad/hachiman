/**
 * PATCH  /api/admin/users/:id { role?, displayName? } — AdminUser. An admin
 *        cannot demote themselves (409).
 * DELETE /api/admin/users/:id — 204. Deletes the account, its owned guilds and
 *        its uploads (lib/admin-users.ts). Not yourself (409).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { deleteUser, updateUser } from '@/lib/admin-users'
import { adminRoute, noContent, parseBody } from '@/lib/api-helpers'
import { assertId } from '@/lib/ids'

const updateUserSchema = z.object({
  role: z.enum(['user', 'admin']).optional(),
  displayName: z.string().trim().min(1).max(64).optional(),
})

export const PATCH = adminRoute<{ id: string }>(async ({ req, params, session }) => {
  const id = assertId(params.id, 'user')
  const body = await parseBody(req, updateUserSchema)
  return NextResponse.json(await updateUser(session.user.id, id, body))
})

export const DELETE = adminRoute<{ id: string }>(async ({ params, session }) => {
  await deleteUser(session.user.id, assertId(params.id, 'user'))
  return noContent()
})
