/**
 * Dates on the account pages. The pages are server components, so "now" is the
 * render time; a reload refreshes it.
 */

const dayFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "27 Aug 2026" */
export function formatDay(iso: string): string {
  return dayFmt.format(new Date(iso))
}

/** "now", "5 min ago", "2 h ago", "yesterday", "12 days ago", then a date. */
export function timeAgo(iso: string, now: number = Date.now()): string {
  const ms = Math.max(0, now - new Date(iso).getTime())
  if (ms < MINUTE) return 'now'
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`
  return daysAgo(iso, now)
}

/** Day granularity: "today", "yesterday", "12 days ago", then a date (older than 60 days). */
export function daysAgo(iso: string, now: number = Date.now()): string {
  const days = Math.floor(Math.max(0, now - new Date(iso).getTime()) / DAY)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 60) return `${days} days ago`
  return `on ${formatDay(iso)}`
}

/**
 * The password line: "Set today" when the password is the one from sign-up,
 * "Changed 12 days ago" after a change, "Set" for accounts from before the
 * column (no date).
 */
export function passwordAge(changedAt: string | null, createdAt: string, now: number = Date.now()): string {
  if (!changedAt) return 'Set'
  const fromSignup = Math.abs(new Date(changedAt).getTime() - new Date(createdAt).getTime()) < MINUTE
  return `${fromSignup ? 'Set' : 'Changed'} ${daysAgo(changedAt, now)}`
}

/** "1 session", "3 sessions" */
export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
