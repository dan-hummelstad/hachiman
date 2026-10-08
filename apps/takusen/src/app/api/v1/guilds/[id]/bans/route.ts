/**
 * GET /api/v1/guilds/:id/bans — Ban[] newest first (BAN_MEMBERS).
 */
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { listBans } from '@/lib/bans'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.BAN_MEMBERS)
    return NextResponse.json(await listBans(id))
  } catch (err) {
    return errorResponse(err)
  }
}
