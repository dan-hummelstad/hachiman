import { useEffect, useState } from 'react'
import { formatClock } from '@/lib/time-format'

const pageVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * `Date.now()`, renewed every `intervalMs` while `active` and the page is visible.
 */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  const [visible, setVisible] = useState(pageVisible)

  useEffect(() => {
    const onChange = (): void => setVisible(pageVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  useEffect(() => {
    if (!active || !visible) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [active, visible, intervalMs])

  return now
}

/**
 * The time since `since` (ms epoch) as `h:mm:ss` or `m:ss`, renewed once a second while the page
 * is visible (N17). Null when `since` is null or not a time.
 */
export function useElapsed(since: number | null): string | null {
  const live = since !== null && Number.isFinite(since)
  const now = useNow(live)
  return live ? formatClock(now - since) : null
}
