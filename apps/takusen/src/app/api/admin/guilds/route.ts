/**
 * GET /api/admin/guilds?query=&cursor=&limit= — Page<AdminGuild>, newest
 * first. `query` matches the guild name. Admin only (contract §4 Admin API).
 */
import { NextResponse } from 'next/server'

import { parseListQuery } from '@/lib/admin'
import { listGuilds } from '@/lib/admin-guilds'
import { adminRoute } from '@/lib/api-helpers'

export const GET = adminRoute(async ({ req }) =>
  NextResponse.json(await listGuilds(parseListQuery(req.nextUrl.searchParams))),
)
