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
import { NotFoundError } from '@/lib/errors'
import { actorDeviceId, loadChannelAccess } from '@/lib/guild-access'
import { addToGroupDm, assertCanMessage, participantsOf, requireGroupDm } from '@/lib/group-dm'
import { toDmChannel } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const addSchema = z.object({ userIds: z.array(z.string().uuid()).min(1) })

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const me = session.user.id
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, me)
    if (access.guild) throw new NotFoundError('Unknown channel')
    requireGroupDm(access.channel)
    const { userIds } = await parseBody(req, addSchema)
    const added = [...new Set(userIds)].filter((u) => !access.participantIds.includes(u))
    if (added.length > 0) await assertCanMessage(me, added)
    await addToGroupDm(access.channel, added, await actorDeviceId(req, me))
    return NextResponse.json(toDmChannel(access.channel, (await participantsOf([id])).get(id) ?? [], me))
  } catch (err) {
    return errorResponse(err)
  }
}
