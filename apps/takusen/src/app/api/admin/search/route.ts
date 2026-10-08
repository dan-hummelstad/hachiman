/**
 * GET /api/admin/search?query= — AdminSearchResult: up to 5 users, guilds,
 * media nodes and regions that match. Empty query: empty lists. Admin only
 * (contract §4 Admin API).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'

import { adminSearch } from '@/lib/admin-stats'
import { adminRoute } from '@/lib/api-helpers'

const querySchema = z.string().trim().max(100)

export const GET = adminRoute(async ({ req }) =>
  NextResponse.json(await adminSearch(querySchema.parse(req.nextUrl.searchParams.get('query') ?? ''))),
)
