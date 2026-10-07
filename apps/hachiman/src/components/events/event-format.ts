import type { GuildEvent, GuildEventWithMe } from '@hachiman/client'
import { isOngoing } from '@/stores/eventsStore'

const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Whole calendar days from the day of `now` to the day of `t` (local time). */
function dayDiff(t: number, now: number): number {
  return Math.round((startOfDay(t) - startOfDay(now)) / 86_400_000)
}

const isMidnight = (d: Date): boolean =>
  d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0

/**
 * The short "when" of the sidebar row: "Now" while ongoing; "Today 21:00", "Tomorrow 21:00";
 * "Thu 21:00" within the week; else the date, "Wed 14 21:00". A start at midnight is a date-only
 * event and shows no time ("Today", "Wed 14").
 */
export function shortEventWhen(e: GuildEventWithMe, now: number, locale?: string): string {
  if (isOngoing(e, now)) return 'Now'
  const start = new Date(e.startsAt)
  const dateOnly = isMidnight(start)
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  }).format(start)
  const days = dayDiff(start.getTime(), now)
  let day: string
  if (days === 0) day = 'Today'
  else if (days === 1) day = 'Tomorrow'
  else if (days > 1 && days < 7 && !dateOnly)
    day = new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(start)
  else day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' }).format(start)
  return dateOnly ? day : `${day} ${time}`
}

/** The full start–end range in the viewer's locale, for the popover. */
export function fullEventRange(
  e: Pick<GuildEvent, 'startsAt' | 'endsAt'>,
  locale?: string
): string {
  const fmt = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' })
  const start = new Date(e.startsAt)
  return e.endsAt === null ? fmt.format(start) : fmt.formatRange(start, new Date(e.endsAt))
}
