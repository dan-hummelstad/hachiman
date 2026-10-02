/**
 * GET /api/v1/guilds/:id/members — Member[] (member).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadGuildAccess } from '@/lib/guild-access'
import { listMembers } from '@/lib/guilds'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadGuildAccess(id, session.user.id)
    return NextResponse.json(await listMembers(id))
  } catch (err) {
    return errorResponse(err)
  }
}
