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
