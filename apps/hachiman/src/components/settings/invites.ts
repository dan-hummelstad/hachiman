// Without ADMINISTRATOR, Takusen allows at most 24 hours (contract §4 "Invite limits").
const LIMITED_EXPIRY = [
  { label: '30 minutes', seconds: 1800 },
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 }
]
const ADMIN_EXPIRY = [
  ...LIMITED_EXPIRY,
  { label: '7 days', seconds: 604800 },
  { label: 'Permanent', seconds: 0 }
]

/** Invite expiry choices (seconds; 0 = permanent). Only an administrator gets more than 24 hours. */
export function inviteExpiryChoices(
  isAdmin: boolean
): readonly { label: string; seconds: number }[] {
  return isAdmin ? ADMIN_EXPIRY : LIMITED_EXPIRY
}

/** False when the choices of `isAdmin` do not list `seconds`, e.g. after a loss of ADMINISTRATOR. */
export function isInviteExpiryChoice(seconds: number, isAdmin: boolean): boolean {
  return inviteExpiryChoices(isAdmin).some((c) => c.seconds === seconds)
}

/** Invite max-use choices; 0 = no limit. */
export const INVITE_MAX_USES = [0, 1, 5, 10, 25, 100]

/** Permanent invites (`expiresAt === null`) first; otherwise the given order (newest first). */
export function sortInvites<T extends { expiresAt: string | null }>(invites: readonly T[]): T[] {
  return [...invites].sort((a, b) => Number(b.expiresAt === null) - Number(a.expiresAt === null))
}

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
