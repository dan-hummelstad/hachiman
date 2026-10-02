import { useState } from 'react'

export interface Draft<T> {
  value: T
  /** Merge `patch` into the draft (clears `saved`). */
  set: (patch: Partial<T>) => void
  /** The (normalized) draft differs from `baseline` in some field. */
  dirty: boolean
  /** Set by `markSaved`, cleared by the next edit; false while dirty. */
  saved: boolean
  markSaved: () => void
  reset: () => void
}

/**
 * Local edit state for a settings form over a live `baseline` (the server copy). The draft starts
 * from the first baseline; later baseline changes move the dirty check, not the draft. `normalize`
 * runs on the draft before comparing (e.g. trim).
 */
export function useDraft<T extends object>(
  baseline: T,
  normalize: (d: T) => T = (d) => d
): Draft<T> {
  const [value, setValue] = useState(baseline)
  const [saved, setSaved] = useState(false)
  const n = normalize(value)
  const dirty = (Object.keys(baseline) as (keyof T)[]).some((k) => n[k] !== baseline[k])
  return {
    value,
    set: (patch) => {
      setValue((d) => ({ ...d, ...patch }))
      setSaved(false)
    },
    dirty,
    saved: saved && !dirty,
    markSaved: () => setSaved(true),
    reset: () => {
      setValue(baseline)
      setSaved(false)
    }
  }
}

/** `normalize` for drafts with a `name` field: compare it trimmed. */
export const trimName = <T extends { name: string }>(d: T): T => ({ ...d, name: d.name.trim() })
