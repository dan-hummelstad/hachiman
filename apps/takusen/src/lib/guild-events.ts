/**
 * Guild events (docs/gateway-protocol.md §4 "Pins, guild events and blocks"). Title, times and
 * the voice channel are plaintext metadata, like a channel topic (§12.1).
 */
import { and, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type { GuildEvent, GuildEventWithMe } from '@hachiman/client/types'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels, guildEventRsvps, guildEvents, type GuildEventRow } from '@/db/schema'
import { NotFoundError, ValidationError } from '@/lib/errors'

export const MAX_EVENT_TITLE = 100
/** An event with no end stays in the list until this long after its start. */
export const OPEN_EVENT_LISTED_MS = 6 * 3600_000
/** The list returns at most this many events, the soonest first. */
export const MAX_LISTED_EVENTS = 100

const title = z.string().trim().min(1).max(MAX_EVENT_TITLE)
const time = z.string().datetime({ offset: true })

export const createEventSchema = z.object({
  title,
  startsAt: time,
  endsAt: time.nullable().optional(),
  channelId: z.string().uuid().nullable().optional(),
})
export const updateEventSchema = createEventSchema.partial()

export type CreateEventBody = z.infer<typeof createEventSchema>
export type UpdateEventBody = z.infer<typeof updateEventSchema>

/**
 * The time rules: `startsAt` in the future when it is set (always on a create),
 * and `endsAt` after `startsAt`. `current` is the stored event of a PATCH.
 */
export function eventTimes(
  body: { startsAt?: string; endsAt?: string | null },
  now: Date,
  current?: Pick<GuildEventRow, 'startsAt' | 'endsAt'>,
): { startsAt: Date; endsAt: Date | null } {
  if (body.startsAt === undefined && current === undefined) throw new ValidationError('startsAt is required')
  const startsAt = body.startsAt !== undefined ? new Date(body.startsAt) : current!.startsAt
  const endsAt = body.endsAt !== undefined ? (body.endsAt === null ? null : new Date(body.endsAt)) : (current?.endsAt ?? null)
  if (body.startsAt !== undefined && startsAt.getTime() <= now.getTime()) {
    throw new ValidationError('startsAt must be in the future')
  }
  if (endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    throw new ValidationError('endsAt must be after startsAt')
  }
  return { startsAt, endsAt }
}

/** True while the list shows the event: upcoming or ongoing. */
export function isListed(e: Pick<GuildEventRow, 'startsAt' | 'endsAt'>, now: Date): boolean {
  if (e.endsAt !== null) return e.endsAt.getTime() > now.getTime()
  return e.startsAt.getTime() + OPEN_EVENT_LISTED_MS > now.getTime()
}

export function toGuildEvent(e: GuildEventRow, rsvpCount: number): GuildEvent {
  return {
    id: e.id,
    guildId: e.guildId,
    channelId: e.channelId,
    title: e.title,
    startsAt: e.startsAt.toISOString(),
    endsAt: e.endsAt ? e.endsAt.toISOString() : null,
    createdBy: e.createdBy,
    createdAt: e.createdAt.toISOString(),
    rsvpCount,
  }
}

/** 400 unless `channelId` is a voice channel of the guild. */
export async function assertEventChannel(guildId: string, channelId: string | null | undefined): Promise<void> {
  if (channelId === null || channelId === undefined) return
  const [row] = await db
    .select({ type: channels.type })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.guildId, guildId)))
    .limit(1)
  if (row?.type !== 'voice') throw new ValidationError('channelId must be a voice channel of the guild')
}

export async function loadEvent(eventId: string): Promise<GuildEventRow> {
  const [row] = await db.select().from(guildEvents).where(eq(guildEvents.id, eventId)).limit(1)
  if (!row) throw new NotFoundError('Unknown event')
  return row
}

export async function rsvpCount(eventId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(guildEventRsvps).where(eq(guildEventRsvps.eventId, eventId))
  return row?.n ?? 0
}

export async function isGoing(eventId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: guildEventRsvps.userId })
    .from(guildEventRsvps)
    .where(and(eq(guildEventRsvps.eventId, eventId), eq(guildEventRsvps.userId, userId)))
    .limit(1)
  return row !== undefined
}

/** The upcoming and ongoing events of a guild, soonest first, with `rsvpCount` and `me`. */
export async function listEvents(guildId: string, userId: string, now: Date): Promise<GuildEventWithMe[]> {
  const openSince = new Date(now.getTime() - OPEN_EVENT_LISTED_MS)
  const rows = await db
    .select()
    .from(guildEvents)
    .where(
      and(
        eq(guildEvents.guildId, guildId),
        or(gt(guildEvents.endsAt, now), and(isNull(guildEvents.endsAt), gt(guildEvents.startsAt, openSince))),
      ),
    )
    .orderBy(guildEvents.startsAt, guildEvents.id)
    .limit(MAX_LISTED_EVENTS)
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)
  const counts = await db
    .select({
      eventId: guildEventRsvps.eventId,
      n: count(),
      me: sql<boolean>`bool_or(${guildEventRsvps.userId} = ${userId})`,
    })
    .from(guildEventRsvps)
    .where(inArray(guildEventRsvps.eventId, ids))
    .groupBy(guildEventRsvps.eventId)
  const byId = new Map(counts.map((c) => [c.eventId, c]))
  return rows.map((r) => ({ ...toGuildEvent(r, byId.get(r.id)?.n ?? 0), me: byId.get(r.id)?.me === true }))
}
