/**
 * GET /api/v1/guilds/:id/admin-actions?after=&limit= — the signed admin chain
 * of the guild, `seq > after` ascending (member only, §12.16). `after`
 * defaults to -1 (from the genesis). `limit` is at most 1000 (default 100).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { ADMIN_ACTIONS_PAGE_DEFAULT, ADMIN_ACTIONS_PAGE_MAX, listAdminActions } from '@/lib/admin-actions'
import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadGuildAccess } from '@/lib/guild-access'

interface RouteContext {
  params: Promise<{ id: string }>
}

const querySchema = z.object({
  after: z.coerce.number().int().min(-1).max(Number.MAX_SAFE_INTEGER).default(-1),
  limit: z.coerce.number().int().min(1).max(ADMIN_ACTIONS_PAGE_MAX).default(ADMIN_ACTIONS_PAGE_DEFAULT),
})

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadGuildAccess(id, session.user.id)
    const params = req.nextUrl.searchParams
    const { after, limit } = querySchema.parse({ after: params.get('after') ?? undefined, limit: params.get('limit') ?? undefined })
    return NextResponse.json(await listAdminActions(id, after, limit))
  } catch (err) {
    return errorResponse(err)
  }
}
