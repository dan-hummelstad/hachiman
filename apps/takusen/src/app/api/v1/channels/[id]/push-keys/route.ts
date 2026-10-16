/**
 * GET /api/v1/channels/:id/push-keys?userIds=<id,id,...> → [{deviceId, userId, pushKey,
 * signature}]: the push keys a sender seals previews to (§4 Push, §12.22). The caller views the
 * channel. A DM gives the keys of every other participant (no `userIds`). A guild channel gives
 * the keys of `userIds` (at most 25, the users that the message mentions) who can view it.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { loadChannelAccess } from '@/lib/guild-access'
import { canViewChannel, pushKeysOf } from '@/lib/push'

const MAX_USERS = 25
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const me = session.user.id
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, me)
    let users: string[]
    if (access.channel.guildId === null) {
      users = access.participantIds.filter((u) => u !== me)
    } else {
      const asked = [...new Set((req.nextUrl.searchParams.get('userIds') ?? '').split(',').filter(Boolean))]
      if (asked.length > MAX_USERS || !asked.every((u) => UUID.test(u))) throw new ValidationError(`userIds: at most ${MAX_USERS} user ids`)
      users = []
      for (const u of asked) if (u !== me && (await canViewChannel(id, u))) users.push(u)
    }
    return NextResponse.json(await pushKeysOf(users))
  } catch (err) {
    return errorResponse(err)
  }
}
