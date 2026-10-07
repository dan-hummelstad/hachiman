import type {} from '@redux-devtools/extension'
import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { GuildEventWithMe } from '@hachiman/client'

/** Mirror of HachimanClient.cache.events (N14). Written only by services/hachiman.ts. */
interface EventsState {
  /** guildId → events, earliest start first. Absent: not loaded. */
  byGuild: Map<string, GuildEventWithMe[]>
}

const initialEventsState = (): EventsState => ({ byGuild: new Map() })

export const useEventsStore = create<EventsState>()(devtools(initialEventsState))

export function resetEventsStore(): void {
  useEventsStore.setState(initialEventsState())
}

const DAY_MS = 86_400_000
/** The sidebar row shows events that start within this time. */
export const NEXT_EVENT_HORIZON_MS = 7 * DAY_MS
/** An event without an end counts as ongoing for this long after its start. */
export const OPEN_EVENT_MS = 2 * 60 * 60_000

const endOf = (e: GuildEventWithMe): number =>
  e.endsAt !== null ? Date.parse(e.endsAt) : Date.parse(e.startsAt) + OPEN_EVENT_MS

export function isOngoing(e: GuildEventWithMe, now: number): boolean {
  return Date.parse(e.startsAt) <= now && now < endOf(e)
}

/**
 * The event for the sidebar row: an ongoing event first (the one that started last), else the
 * next one that starts within NEXT_EVENT_HORIZON_MS. Null when there is none.
 */
export function nextEvent(
  events: readonly GuildEventWithMe[],
  now: number
): GuildEventWithMe | null {
  let ongoing: GuildEventWithMe | null = null
  let next: GuildEventWithMe | null = null
  for (const e of events) {
    const start = Date.parse(e.startsAt)
    if (isOngoing(e, now)) {
      if (!ongoing || start > Date.parse(ongoing.startsAt)) ongoing = e
    } else if (start > now && start - now <= NEXT_EVENT_HORIZON_MS) {
      if (!next || start < Date.parse(next.startsAt)) next = e
    }
  }
  return ongoing ?? next
}

export const byStart = (a: GuildEventWithMe, b: GuildEventWithMe): number =>
  a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id)

const EMPTY_EVENTS: GuildEventWithMe[] = []

/** The loaded events of a guild, earliest start first. */
export function useGuildEvents(guildId: string | null): GuildEventWithMe[] {
  return useEventsStore((s) =>
    guildId !== null ? (s.byGuild.get(guildId) ?? EMPTY_EVENTS) : EMPTY_EVENTS
  )
}

const NEXT_EVENT_TICK_MS = 60_000

/** `nextEvent` of a guild. Updates when the events change, and once a minute. */
export function useNextEvent(guildId: string | null): GuildEventWithMe | null {
  const events = useGuildEvents(guildId)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), NEXT_EVENT_TICK_MS)
    return () => clearInterval(t)
  }, [])
  return useMemo(() => nextEvent(events, now), [events, now])
}
