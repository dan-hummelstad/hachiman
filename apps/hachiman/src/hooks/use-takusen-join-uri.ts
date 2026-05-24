/**
 * useTakusenJoinUri — listen for incoming takusen://join URIs.
 *
 * Wires three event sources into a single state machine:
 *  1. Electron main process pushing the URI over IPC via `window.takusen.onJoinUri`.
 *  2. The browser host visiting `/join#<payload>` (cold-start fallback).
 *  3. Hash changes while on `/join` (re-paste/refresh).
 *
 * The host apps decide which sources are active. The hook stays passive: it
 * subscribes to whatever is present on `window` and unsubscribes on unmount.
 */
import { useEffect, useState } from 'react'

import {
  parseAndVerifyHash,
  parseLocationHashIfJoin,
  parseTakusenUri,
  type JoinUriParseResult
} from '@/services/JoinUriService'

interface JoinUriBridge {
  /**
   * Subscribe to inbound takusen://join URIs from the OS (Electron main
   * forwards `open-url` / `second-instance` events here). Returns an
   * unsubscribe function.
   */
  onJoinUri(callback: (uri: string) => void): () => void
}

declare global {
  interface Window {
    takusen?: JoinUriBridge
  }
}

export interface TakusenJoinUriState {
  /** Last successfully parsed payload (verified or not). */
  result: JoinUriParseResult | null
  /** Bumps on every new arrival so callers can re-open a closed modal. */
  arrivalCount: number
  /** Dismiss the current result without consuming subsequent arrivals. */
  clear: () => void
}

export function useTakusenJoinUri(): TakusenJoinUriState {
  const [result, setResult] = useState<JoinUriParseResult | null>(null)
  const [arrivalCount, setArrivalCount] = useState(0)

  useEffect(() => {
    let cancelled = false

    const dispatch = (next: JoinUriParseResult): void => {
      if (cancelled) return
      setResult(next)
      setArrivalCount((n) => n + 1)
    }

    // (1) Electron IPC bridge.
    const offIpc = window.takusen?.onJoinUri((uri) => {
      void parseTakusenUri(uri).then(dispatch)
    })

    // (2) Browser cold-start: if we landed on /join#…, parse immediately.
    void parseLocationHashIfJoin().then((r) => {
      if (r) dispatch(r)
    })

    // (3) Same-tab hash change (e.g. user re-pastes a /join# URL while the
    //     SPA is loaded). The 'hashchange' event fires for fragment-only nav.
    const onHashChange = (): void => {
      if (window.location.pathname.replace(/\/+$/, '') !== '/join') return
      const hash = window.location.hash.startsWith('#')
        ? window.location.hash.slice(1)
        : window.location.hash
      if (!hash) return
      void parseAndVerifyHash(hash).then(dispatch)
    }
    window.addEventListener('hashchange', onHashChange)

    return () => {
      cancelled = true
      offIpc?.()
      window.removeEventListener('hashchange', onHashChange)
    }
  }, [])

  const clear = (): void => setResult(null)
  return { result, arrivalCount, clear }
}
