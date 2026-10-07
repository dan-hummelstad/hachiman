/**
 * PUT    /api/v1/events/:id/rsvp — the caller is going (member). 204.
 * DELETE /api/v1/events/:id/rsvp — the caller is not going (member). 204.
 * A change publishes GUILD_EVENT_RSVP { eventId, guildId, userId, going, rsvpCount }
 * to the guild. A repeated PUT or DELETE publishes nothing.
 */
import { and, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { guildEventRsvps } from '@/db/schema'
import { errorResponse, noContent } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { publishToGuild } from '@/lib/events'
import { loadGuildAccess } from '@/lib/guild-access'
import { loadEvent, rsvpCount } from '@/lib/guild-events'
import { assertId } from '@/lib/ids'

interface RouteContext {
  params: Promise<{ id: string }>
}

async function rsvp(ctx: RouteContext, going: boolean): Promise<NextResponse> {
  const session = await requireUser()
  const userId = session.user.id
  const { id } = await ctx.params
  assertId(id, 'event')
  const event = await loadEvent(id)
  await loadGuildAccess(event.guildId, userId)
  const changed = going
    ? await db.insert(guildEventRsvps).values({ eventId: id, userId }).onConflictDoNothing().returning()
    : await db
        .delete(guildEventRsvps)
        .where(and(eq(guildEventRsvps.eventId, id), eq(guildEventRsvps.userId, userId)))
        .returning()
  if (changed.length > 0) {
    await publishToGuild(event.guildId, 'GUILD_EVENT_RSVP', {
      eventId: id,
      guildId: event.guildId,
      userId,
      going,
      rsvpCount: await rsvpCount(id),
    })
  }
  return noContent()
}

export async function PUT(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    return await rsvp(ctx, true)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    return await rsvp(ctx, false)
  } catch (err) {
    return errorResponse(err)
  }
}
