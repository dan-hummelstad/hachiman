/**
 * GET /api/admin/users?query=&role=&cursor=&limit= — Page<AdminUser>, newest
 * first. `query` matches email or display name. Admin only (contract §4 Admin API).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { parseListQuery } from '@/lib/admin'
import { listUsers } from '@/lib/admin-users'
import { adminRoute } from '@/lib/api-helpers'

const roleSchema = z.enum(['user', 'admin']).optional()

export const GET = adminRoute(async ({ req }) => {
  const params = req.nextUrl.searchParams
  const role = roleSchema.parse(params.get('role') || undefined)
  return NextResponse.json(await listUsers(parseListQuery(params), role))
})
