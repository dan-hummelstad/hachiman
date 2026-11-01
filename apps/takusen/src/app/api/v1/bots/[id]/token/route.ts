/**
 * POST /api/v1/bots/:id/token — the owner revokes the bot's token and gets a
 * new one: {token}. The token is shown only here (contract §4 Bots). 404 for
 * a bot of another user.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { resetBotToken } from '@/lib/bot-accounts'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const token = await resetBotToken(session.user.id, (await ctx.params).id)
    return NextResponse.json({ token })
  } catch (err) {
    return errorResponse(err)
  }
}
