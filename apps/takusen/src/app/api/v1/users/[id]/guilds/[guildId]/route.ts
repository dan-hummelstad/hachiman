/**
 * DELETE /api/v1/users/@me/guilds/:guildId — leave a guild (the owner can't;
 * they delete it instead). Publishes the same events as a kick, and queues the
 * same DS Removes (§12.18).
 */
import { type NextRequest, type NextResponse } from 'next/server'

import { errorResponse, noContent, requireMe } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { actorDeviceId, loadGuildAccess } from '@/lib/guild-access'
import { removeMember } from '@/lib/guilds'

interface RouteContext {
  params: Promise<{ id: string; guildId: string }>
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, guildId } = await ctx.params
    requireMe(id)
    const access = await loadGuildAccess(guildId, session.user.id)
    if (access.guild.ownerId === session.user.id) {
      throw new ValidationError('The owner cannot leave a guild; delete it instead')
    }
    await removeMember(guildId, session.user.id, await actorDeviceId(req, session.user.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
