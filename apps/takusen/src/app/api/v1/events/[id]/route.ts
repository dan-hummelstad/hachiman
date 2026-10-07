/**
 * PATCH  /api/v1/events/:id { title?, startsAt?, endsAt?, channelId? } —
 *        MANAGE_EVENTS in the event's guild. Publishes GUILD_EVENT_UPDATE.
 * DELETE /api/v1/events/:id — MANAGE_EVENTS. Publishes GUILD_EVENT_DELETE. 204.
 */
import { eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { guildEvents } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { publishToGuild } from '@/lib/events'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import {
  assertEventChannel,
  eventTimes,
  isGoing,
  loadEvent,
  rsvpCount,
  toGuildEvent,
  updateEventSchema,
} from '@/lib/guild-events'
import { assertId } from '@/lib/ids'

interface RouteContext {
  params: Promise<{ id: string }>
}

async function manageableEvent(ctx: RouteContext) {
  const session = await requireUser()
  const { id } = await ctx.params
  assertId(id, 'event')
  const event = await loadEvent(id)
  const access = await loadGuildAccess(event.guildId, session.user.id)
  requirePermission(access.permissions, Permissions.MANAGE_EVENTS)
  return { event, userId: session.user.id }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { event, userId } = await manageableEvent(ctx)
    const body = await parseBody(req, updateEventSchema)
    const times = eventTimes(body, new Date(), event)
    if (body.channelId !== undefined) await assertEventChannel(event.guildId, body.channelId)
    const [row] = await db
      .update(guildEvents)
      .set({
        ...times,
        ...(body.title !== undefined ? { title: body.title } : {}),
        ...(body.channelId !== undefined ? { channelId: body.channelId } : {}),
      })
      .where(eq(guildEvents.id, event.id))
      .returning()
    const [updated, mine] = await Promise.all([rsvpCount(event.id), isGoing(event.id, userId)])
    const wire = toGuildEvent(row!, updated)
    await publishToGuild(event.guildId, 'GUILD_EVENT_UPDATE', wire)
    return NextResponse.json({ ...wire, me: mine })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { event } = await manageableEvent(ctx)
    await db.delete(guildEvents).where(eq(guildEvents.id, event.id))
    await publishToGuild(event.guildId, 'GUILD_EVENT_DELETE', { id: event.id, guildId: event.guildId })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
