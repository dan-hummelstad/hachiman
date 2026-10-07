import { useCallback, useEffect, useState } from 'react'

/** Text for the clipboard, or a function that copies (e.g. InviteService.copyInviteLink). */
export type CopySource = string | (() => Promise<void>)

export interface CopyState {
  /** The key of the last copy that worked ('' without a key), or null. */
  copied: string | null
  /** The last copy failed. */
  failed: boolean
  copy: (source: CopySource, key?: string) => void
  /** Back to "Copy", e.g. when the text to copy changes. */
  reset: () => void
}

/**
 * The "Copy" → "Copied" pattern. `copied` goes back to null after `resetMs` (null: it stays until
 * reset). A failure sets `failed` and calls `onError`.
 */
export function useCopy({
  resetMs = 1500,
  onError
}: { resetMs?: number | null; onError?: (e: unknown) => void } = {}): CopyState {
  const [copied, setCopied] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (copied === null || resetMs === null) return
    const t = setTimeout(() => setCopied(null), resetMs)
    return () => clearTimeout(t)
  }, [copied, resetMs])

  const copy = useCallback(
    (source: CopySource, key = ''): void => {
      setFailed(false)
      Promise.resolve()
        .then(() => (typeof source === 'string' ? navigator.clipboard.writeText(source) : source()))
        .then(
          () => setCopied(key),
          (e: unknown) => {
            setCopied(null)
            setFailed(true)
            if (onError) onError(e)
            else console.warn('[copy] failed', e)
          }
        )
    },
    [onError]
  )
  const reset = useCallback((): void => {
    setCopied(null)
    setFailed(false)
  }, [])

  return { copied, failed, copy, reset }
}
