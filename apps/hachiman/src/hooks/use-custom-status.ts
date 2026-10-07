import { useEffect, useReducer } from 'react'
import type { CustomStatus } from '@hachiman/client'
import { useGuildStore } from '@/stores/guildStore'

/** The status unless it expired at `now`. The gateway sends no event at expiry (§1). */
export function visibleCustomStatus(
  status: CustomStatus | undefined,
  now: number
): CustomStatus | null {
  if (!status) return null
  if (status.expiresAt !== null && Date.parse(status.expiresAt) <= now) return null
  return status
}

/** setTimeout fires at once for a larger delay. */
const MAX_TIMER_MS = 2_147_483_647

/** The custom status of a user (N16), or null. Re-renders when it expires. */
export function useCustomStatus(userId: string): CustomStatus | null {
  const status = useGuildStore((s) => s.customStatuses.get(userId))
  const [ticks, tick] = useReducer((n: number) => n + 1, 0)
  const visible = visibleCustomStatus(status, Date.now())
  const expiresAt = visible?.expiresAt ?? null
  useEffect(() => {
    if (expiresAt === null) return
    const wait = Math.min(Math.max(0, Date.parse(expiresAt) - Date.now()), MAX_TIMER_MS)
    const t = setTimeout(tick, wait)
    return () => clearTimeout(t)
  }, [expiresAt, ticks])
  return visible
}
