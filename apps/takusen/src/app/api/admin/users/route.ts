/**
 * GET /api/admin/users?query=&role=&filter=&cursor=&limit= — Page<AdminUser>, newest
 * first. `query` matches email or display name. `filter` is `unverified` or
 * `signed_in`. Admin only (contract §4 Admin API).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { parseListQuery } from '@/lib/admin'
import { listUsers } from '@/lib/admin-users'
import { adminRoute } from '@/lib/api-helpers'

const roleSchema = z.enum(['user', 'admin']).optional()
const filterSchema = z.enum(['unverified', 'signed_in']).optional()

export const GET = adminRoute(async ({ req }) => {
  const params = req.nextUrl.searchParams
  const role = roleSchema.parse(params.get('role') || undefined)
  const filter = filterSchema.parse(params.get('filter') || undefined)
  return NextResponse.json(await listUsers(parseListQuery(params), role, filter))
})
