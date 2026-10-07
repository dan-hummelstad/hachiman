/**
 * GET /api/v1/invites/:code/bundles → InviteBundles (§12.11.4, §12.12): the
 * record and the sealed bundles of an invite with history, for a member who
 * joined with it, during INVITE_BUNDLE_FETCH_WINDOW_MS after the join. Every
 * other caller gets 404 UnknownInvite.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { drizzleInviteHistoryStore, inviteBundlesOf } from '@/lib/invite-history'
import { getInviteByCode } from '@/lib/invites'

interface RouteContext {
  params: Promise<{ code: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { code } = await ctx.params
    return NextResponse.json(await inviteBundlesOf(drizzleInviteHistoryStore(), await getInviteByCode(code), session.user.id, new Date()))
  } catch (err) {
    return errorResponse(err)
  }
}
