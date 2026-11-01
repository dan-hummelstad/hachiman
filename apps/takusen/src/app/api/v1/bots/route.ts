/**
 * GET  /api/v1/bots — BotSummary[]: the caller's bots, oldest first.
 * POST /api/v1/bots {name} — 201 {bot: User, token}. The token is shown only
 *      here. Only a user that is not a bot may create bots (403). At most
 *      MAX_BOTS_PER_OWNER bots per user (409 TooManyBots). Contract §4 Bots.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { botNameSchema, createBot, listBots } from '@/lib/bot-accounts'

const createSchema = z.object({ name: botNameSchema })

export async function GET(): Promise<NextResponse> {
  try {
    const session = await requireUser()
    return NextResponse.json(await listBots(session.user.id))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { name } = await parseBody(req, createSchema)
    return NextResponse.json(await createBot(session.user.id, name), { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
