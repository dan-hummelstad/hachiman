/**
 * GET /api/v1/users/@me/bot → {ownerId}: the owner of the calling bot (contract §4 Bots). The bot
 * pins it on its first start, and accepts link codes only in a DM from that user. A user that is
 * not a bot gets 403.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireBotCaller } from '@/lib/bot-link'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { ownerId } = await requireBotCaller((await ctx.params).id)
    return NextResponse.json({ ownerId })
  } catch (err) {
    return errorResponse(err)
  }
}
