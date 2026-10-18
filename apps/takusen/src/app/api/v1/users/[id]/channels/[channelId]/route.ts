/**
 * DELETE /api/v1/users/@me/channels/:channelId — leave a group DM (§4 DMs).
 * The caller's devices get DS Removes (§12.18). An owner who leaves passes the
 * group on; the last one to leave deletes it. A 1:1 DM cannot be left.
 */
import { type NextRequest, type NextResponse } from 'next/server'

import { errorResponse, noContent, requireMe } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { actorDeviceId, loadChannelAccess } from '@/lib/guild-access'
import { asGroupDm, leaveGroupDm } from '@/lib/group-dm'

interface RouteContext {
  params: Promise<{ id: string; channelId: string }>
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const me = (await requireUser()).user.id
    const { id, channelId } = await ctx.params
    requireMe(id)
    const dm = asGroupDm(await loadChannelAccess(channelId, me))
    await leaveGroupDm(dm, me, await actorDeviceId(req, me))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
