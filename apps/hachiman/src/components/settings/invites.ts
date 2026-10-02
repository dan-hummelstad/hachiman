/** Invite expiry choices (seconds; 0 = never). */
export const INVITE_EXPIRY = [
  { label: '30 minutes', seconds: 1800 },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 604800 },
  { label: 'Never', seconds: 0 }
]

/** Invite max-use choices; 0 = no limit. */
export const INVITE_MAX_USES = [0, 1, 5, 10, 25, 100]

const RELATIVE = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60]
]

/** Compact relative expiry: "in 6 days", "in 3 hours", "Never" (null), "Expired" (past). */
export function formatExpiry(expiresAt: string | null): string {
  if (!expiresAt) return 'Never'
  const secs = (new Date(expiresAt).getTime() - Date.now()) / 1000
  if (secs <= 0) return 'Expired'
  for (const [unit, size] of UNITS) {
    if (secs >= size) return RELATIVE.format(Math.round(secs / size), unit)
  }
  return RELATIVE.format(Math.max(1, Math.round(secs)), 'second')
}
