/**
 * GET  /api/v1/guilds/:id/events — the upcoming and ongoing GuildEvents with
 *      `rsvpCount` and `me`, soonest first (member).
 * POST /api/v1/guilds/:id/events { title, startsAt, endsAt?, channelId? } —
 *      MANAGE_EVENTS. Publishes GUILD_EVENT_CREATE to the guild.
 */
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { guildEvents } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { publishToGuild } from '@/lib/events'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { assertEventChannel, createEventSchema, eventTimes, listEvents, toGuildEvent } from '@/lib/guild-events'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadGuildAccess(id, session.user.id)
    return NextResponse.json(await listEvents(id, session.user.id, new Date()))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_EVENTS)
    const body = await parseBody(req, createEventSchema)
    const times = eventTimes(body, new Date())
    await assertEventChannel(id, body.channelId)
    const [row] = await db
      .insert(guildEvents)
      .values({ guildId: id, channelId: body.channelId ?? null, title: body.title, ...times, createdBy: session.user.id })
      .returning()
    const event = toGuildEvent(row!, 0)
    await publishToGuild(id, 'GUILD_EVENT_CREATE', event)
    return NextResponse.json({ ...event, me: false })
  } catch (err) {
    return errorResponse(err)
  }
}
