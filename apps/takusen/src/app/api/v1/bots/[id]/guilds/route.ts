/**
 * POST /api/v1/bots/:id/guilds {guildId} — the owner adds the bot to a guild
 * where the owner has MANAGE_GUILD (contract §4 Bots): an invite join, as
 * Discord's bot invite. Returns the GuildFull of the bot. 404 for a bot of
 * another user.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { addBotToGuild } from '@/lib/bot-accounts'

interface RouteContext {
  params: Promise<{ id: string }>
}

const bodySchema = z.object({ guildId: z.string().uuid() })

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { guildId } = await parseBody(req, bodySchema)
    return NextResponse.json(await addBotToGuild(session.user.id, (await ctx.params).id, guildId))
  } catch (err) {
    return errorResponse(err)
  }
}
