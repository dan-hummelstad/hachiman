import { useCallback, useState } from 'react'
import { errMsg } from '@/lib/utils'

/** Outcome of `Action.run`: the resolved value, or `ok: false` after the error was recorded. */
export type ActionResult<T> = { ok: true; value: T } | { ok: false }

export interface Action {
  /**
   * Run `fn` with `busy` set; on rejection set `error` to "Could not <what>: <message>" and
   * resolve `{ ok: false }` instead of throwing. Clears any previous error first.
   */
  run: <T>(what: string, fn: () => Promise<T>) => Promise<ActionResult<T>>
  busy: boolean
  error: string | null
  /** Set a non-thrown error (e.g. form validation). */
  setError: (error: string | null) => void
  clearError: () => void
}

/** Busy + inline-error bookkeeping for one async user action (submit, delete, save…). */
export function useAction(): Action {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = useCallback(
    async <T>(what: string, fn: () => Promise<T>): Promise<ActionResult<T>> => {
      setBusy(true)
      setError(null)
      try {
        return { ok: true, value: await fn() }
      } catch (e) {
        const message = `Could not ${what}: ${errMsg(e)}`
        console.warn(`[action] ${message}`)
        setError(message)
        return { ok: false }
      } finally {
        setBusy(false)
      }
    },
    []
  )
  const clearError = useCallback(() => setError(null), [])
  return { run, busy, error, setError, clearError }
}
