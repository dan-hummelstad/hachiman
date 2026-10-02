import { useEffect, useState } from 'react'
import { errMsg } from '@/lib/utils'

export type KeyedResult<T> = { data: T; error?: undefined } | { data?: undefined; error: string }

/**
 * `fn(key)` for the current `key`; null while it loads or when `key` is null. The result is tagged
 * with its key, so a new key shows "loading" at once and a late answer for an old key never shows.
 * `fn` is read when `key` changes; it is not a dependency.
 */
export function useKeyedAsync<T>(
  key: string | null,
  fn: (key: string) => Promise<T>
): KeyedResult<T> | null {
  const [result, setResult] = useState<{ key: string; value: KeyedResult<T> } | null>(null)

  useEffect(() => {
    if (key === null) return
    let live = true
    fn(key).then(
      (data) => live && setResult({ key, value: { data } }),
      (e: unknown) => live && setResult({ key, value: { error: errMsg(e) } })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return result && result.key === key ? result.value : null
}
