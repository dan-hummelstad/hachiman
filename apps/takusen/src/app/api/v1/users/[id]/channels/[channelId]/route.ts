/**
 * DELETE /api/v1/users/@me/channels/:channelId — leave a group DM (§4 DMs).
 * The caller's devices get DS Removes (§12.18). An owner who leaves passes the
 * group on; the last one to leave deletes it. A 1:1 DM cannot be left.
 */
import { type NextRequest, type NextResponse } from 'next/server'

import { errorResponse, noContent, requireMe } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { NotFoundError } from '@/lib/errors'
import { actorDeviceId, loadChannelAccess } from '@/lib/guild-access'
import { leaveGroupDm, requireGroupDm } from '@/lib/group-dm'

interface RouteContext {
  params: Promise<{ id: string; channelId: string }>
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, channelId } = await ctx.params
    requireMe(id)
    const access = await loadChannelAccess(channelId, session.user.id)
    if (access.guild) throw new NotFoundError('Unknown channel')
    requireGroupDm(access.channel)
    await leaveGroupDm(access.channel, session.user.id, await actorDeviceId(req, session.user.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
