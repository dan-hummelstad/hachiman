/**
 * POST /api/v1/channels/:id/recipients { userIds } — any participant adds
 * people to a group DM (§4 DMs). Each must share a guild with the caller, with
 * no block either way; the group stays within `Limits.maxGroupDmMembers`. The
 * DS queues Adds for their devices (`dm_participants_changed`, §12.18).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { actorDeviceId, loadChannelAccess } from '@/lib/guild-access'
import { addToGroupDm, asGroupDm } from '@/lib/group-dm'

interface RouteContext {
  params: Promise<{ id: string }>
}

const addSchema = z.object({ userIds: z.array(z.string().uuid()).min(1) })

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const me = (await requireUser()).user.id
    const dm = asGroupDm(await loadChannelAccess((await ctx.params).id, me))
    const { userIds } = await parseBody(req, addSchema)
    return NextResponse.json(await addToGroupDm(dm, me, userIds, await actorDeviceId(req, me)))
  } catch (err) {
    return errorResponse(err)
  }
}
