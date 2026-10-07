const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000]
]

/** "just now" under a minute, else "5 minutes ago", "yesterday", "3 days ago". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Date.parse(iso) - now
  if (!Number.isFinite(diff) || Math.abs(diff) < 60_000) return 'just now'
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return RELATIVE.format(Math.round(diff / ms), unit)
  }
  return 'just now'
}
