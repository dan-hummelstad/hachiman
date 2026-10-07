import { useEffect, useState } from 'react'
import { formatElapsed } from '@/lib/member-activity'

const pageVisible = (): boolean =>
  typeof document === 'undefined' || document.visibilityState === 'visible'

/**
 * The time since `since` (ms epoch) as `h:mm:ss` or `m:ss`, renewed once a second while the page
 * is visible (N17). Null when `since` is null.
 */
export function useElapsed(since: number | null): string | null {
  const [now, setNow] = useState(() => Date.now())
  const [visible, setVisible] = useState(pageVisible)

  useEffect(() => {
    const onChange = (): void => setVisible(pageVisible())
    document.addEventListener('visibilitychange', onChange)
    return () => document.removeEventListener('visibilitychange', onChange)
  }, [])

  useEffect(() => {
    if (since === null || !visible) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [since, visible])

  return since === null ? null : formatElapsed(now - since)
}
