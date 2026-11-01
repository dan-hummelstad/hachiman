/**
 * GET  /api/v1/users/@me/bot/link-requests → BotLinkRequest[] (newest first)
 * POST /api/v1/users/@me/bot/link-requests {blob} → 201 BotLinkRequest
 *
 * The link mailbox of the calling bot (contract §4 Bots "Device linking"): sealed QR link payloads
 * that only the bot's own devices can open. Requests live 10 minutes, as a link session.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { listBotLinkRequests, postBotLinkRequest, requireBotCaller } from '@/lib/bot-link'

interface RouteContext {
  params: Promise<{ id: string }>
}

/** A sealed QR payload is under 1 KiB; 4096 characters is a generous cap. */
const bodySchema = z.object({ blob: z.string().regex(/^[A-Za-z0-9_-]{32,4096}$/) })

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { userId } = await requireBotCaller((await ctx.params).id)
    return NextResponse.json(await listBotLinkRequests(userId))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { userId } = await requireBotCaller((await ctx.params).id)
    const { blob } = await parseBody(req, bodySchema)
    return NextResponse.json(await postBotLinkRequest(userId, blob), { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
