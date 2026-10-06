/**
 * GET /api/v1/guilds/:id/invite-records → InviteRecord[] (member only,
 * §12.11.4, §12.12): the invites with history that are not revoked, expired
 * or exhausted, with the newest stored bundle epoch of each group. Member
 * devices check each record and send the bundles of their commits.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadGuildAccess } from '@/lib/guild-access'
import { drizzleInviteHistoryStore, listInviteRecords } from '@/lib/invite-history'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    return NextResponse.json(await listInviteRecords(drizzleInviteHistoryStore(), access.guild.id, new Date()))
  } catch (err) {
    return errorResponse(err)
  }
}
