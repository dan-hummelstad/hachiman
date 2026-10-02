/**
 * POST /api/v1/channels/:id/typing — SEND_MESSAGES; publishes TYPING_START.
 */
import { Permissions } from '@hachiman/client/permissions'
import { type NextRequest, type NextResponse } from 'next/server'

import { errorResponse, noContent } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadChannelAccess, publishToChannel, requirePermission } from '@/lib/guild-access'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.SEND_MESSAGES)
    await publishToChannel(access, 'TYPING_START', {
      channelId: id,
      guildId: access.channel.guildId,
      userId: session.user.id,
      timestamp: new Date().toISOString(),
    })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
