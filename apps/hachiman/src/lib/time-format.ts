/**
 * The time formatters of the UI: relative times, invite expiry, clocks (timers, playback) and
 * short dates.
 */

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
]

/** `diffMs` (negative = past) in the largest unit that fits, or null under a minute. */
function inUnits(diffMs: number): string | null {
  for (const [unit, ms] of UNITS)
    if (Math.abs(diffMs) >= ms) return RELATIVE.format(Math.round(diffMs / ms), unit)
  return null
}

/**
 * "just now" within a minute, else "5 minutes ago", "yesterday", "3 days ago" for the past and
 * "in 5 minutes", "tomorrow" for the future.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Date.parse(iso) - now
  if (!Number.isFinite(diff)) return 'just now'
  return inUnits(diff) ?? 'just now'
}

/** Compact relative expiry: "in 6 days", "in 3 hours", "Never" (null), "Expired" (past). */
export function formatExpiry(expiresAt: string | null, now: number = Date.now()): string {
  if (!expiresAt) return 'Never'
  const diff = Date.parse(expiresAt) - now
  if (!(diff > 0)) return 'Expired'
  return inUnits(diff) ?? RELATIVE.format(Math.max(1, Math.round(diff / 1000)), 'second')
}

/**
 * `h:mm:ss`, or `m:ss` under an hour, for a time in ms: a call timer or a playback position.
 * Negative and non-finite count as 0.
 */
export function formatClock(ms: number): string {
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const ss = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const SHORT_DATE = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric'
})

/** A date as "12 Mar 2026" (in the locale's order): when a device was added. */
export function formatShortDate(date: Date | number): string {
  return SHORT_DATE.format(date)
}

const DAY_MONTH = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

/**
 * The day and month of an ISO time ("2 Oct", in the locale's order): the day of a verification on
 * the mobile layout. Null for no time or a broken one.
 */
export function formatDayMonth(iso: string | null): string | null {
  if (iso === null) return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? DAY_MONTH.format(ms) : null
}

/** The start of the local calendar day of `ms`. */
export const dayStart = (ms: number): number => {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/**
 * The calendar days from `ms` back to `now`: 0 the same day, 1 the day before, negative for a
 * later day. DST shifts make a day 23 or 25 hours long, so the count rounds.
 */
export const calendarDaysAgo = (ms: number, now: number): number =>
  Math.round((dayStart(now) - dayStart(ms)) / 86_400_000)

/**
 * The day and month ("6 Oct", in the locale's order), with the year when it is not the year of
 * `now` ("6 Oct 2025"): the date of a list row, a key log row or a block.
 */
export function formatDayMonthYear(
  at: Date | number,
  now: number = Date.now(),
  locale?: string
): string {
  const date = new Date(typeof at === 'number' ? at : at.getTime())
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' })
  }).format(date)
}

/**
 * The time of a list row's last activity (the DM list, M56): "10:53" today (24 h), the weekday
 * within the last six days ("Mon"), else the date (`formatDayMonthYear`). A time in the future
 * (clock skew) counts as today.
 */
export function formatListTime(
  at: Date | number,
  now: number = Date.now(),
  locale?: string
): string {
  const ms = typeof at === 'number' ? at : at.getTime()
  const date = new Date(ms)
  const days = calendarDaysAgo(ms, now)
  if (days <= 0)
    return new Intl.DateTimeFormat(locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(date)
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)
  return formatDayMonthYear(date, now, locale)
}
