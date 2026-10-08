/**
 * Dates, times, sizes and counts for every Takusen page, in one locale so
 * that server and client renders agree. Server components format at render
 * time; a reload refreshes "now".
 */

const LOCALE = 'en-GB'

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const dateFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' })
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'short' })
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium', timeStyle: 'medium' })

/** "27 Aug 2026" */
export const formatDate = (iso: string): string => dateFmt.format(new Date(iso))
/** "29 Sept" */
export const formatDayShort = (iso: string): string => dayFmt.format(new Date(iso))
/** "27 Aug 2026, 14:03:12" */
export const formatDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso))

/** "1 channel", "14 channels" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The largest unit that fits, past or future: "now", "3 s ago", "4 min ago",
 * "2 h ago", "yesterday", "in 6 days". After 60 days, the date.
 */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const diff = new Date(iso).getTime() - now
  const abs = Math.abs(diff)
  const say = (amount: string): string => (diff < 0 ? `${amount} ago` : `in ${amount}`)
  if (abs < SECOND) return 'now'
  if (abs < MINUTE) return say(`${Math.floor(abs / SECOND)} s`)
  if (abs < HOUR) return say(`${Math.floor(abs / MINUTE)} min`)
  if (abs < DAY) return say(`${Math.floor(abs / HOUR)} h`)
  const days = Math.floor(abs / DAY)
  if (days === 1) return diff < 0 ? 'yesterday' : 'tomorrow'
  if (days <= 60) return say(`${days} days`)
  return `on ${formatDate(iso)}`
}

/** "1 hour", "30 minutes", "3 days 4 hours": the two largest units. */
export function formatDuration(seconds: number): string {
  const parts: string[] = []
  let rest = Math.max(0, Math.floor(seconds))
  for (const [unit, size] of [
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
  ] as const) {
    const n = Math.floor(rest / size)
    rest -= n * size
    if (n > 0 || parts.length > 0) parts.push(plural(n, unit))
  }
  const shown = parts.slice(0, 2).filter((p) => !p.startsWith('0 '))
  return shown.length > 0 ? shown.join(' ') : plural(0, 'minute')
}

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/**
 * The password line: "Set 30 days ago" for the password from sign-up (sign-up writes
 * `passwordChangedAt` = `createdAt`), "Changed 12 days ago" after a change, "Set" for accounts
 * from before the column (no date). `lowerCase` for the middle of a line ("changed 12 days ago").
 */
export function passwordAge(
  changedAt: string | null,
  createdAt: string,
  { lowerCase = false, now = Date.now() }: { lowerCase?: boolean; now?: number } = {},
): string {
  const [set, changed] = lowerCase ? ['set', 'changed'] : ['Set', 'Changed']
  const verb = !changedAt || changedAt === createdAt ? set : changed
  return changedAt ? `${verb} ${formatRelative(changedAt, now)}` : verb
}
