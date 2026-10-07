/**
 * POST /api/v1/channels/:id/ack { messageId } — VIEW_CHANNEL; moves the read
 * state of the caller forward and publishes READ_STATE_UPDATE to `user:{id}`.
 * An ack for an older message is ignored (204, no event).
 */
import { type NextRequest, type NextResponse } from 'next/server'
import { z } from 'zod'

import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadChannelAccess } from '@/lib/guild-access'
import { redisRateLimiter } from '@/lib/mls/context'
import { ackMessage, drizzleReadStateStore } from '@/lib/read-states'

interface RouteContext {
  params: Promise<{ id: string }>
}

const ackSchema = z.object({ messageId: z.string().uuid() })

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    const { messageId } = await parseBody(req, ackSchema)
    await ackMessage(drizzleReadStateStore, redisRateLimiter, {
      userId: session.user.id,
      channelId: id,
      permissions: access.permissions,
      messageId,
    })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
