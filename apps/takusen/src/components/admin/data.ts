import { useCallback, useEffect, useState } from 'react'

import type { Page } from '@/lib/admin'
import { apiFetch } from '@/lib/api-fetch'

/**
 * Data hooks of the admin console. Every view reads and writes through /api/admin (contract §4
 * Admin API), so the console and the API cannot drift apart.
 */

/** Calls /api/admin`path` with the dashboard cookie. Throws the envelope's message on failure. */
export function adminFetch<T = void>(path: string, init?: RequestInit): Promise<T> {
  return apiFetch<T>('/api/admin', path, init)
}

/** Drains a media node (placement skips it, its calls go on) or puts it back into placement. */
export function setNodeDrain(nodeId: string, drain: boolean): Promise<void> {
  return adminFetch(`/media-nodes/${encodeURIComponent(nodeId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: drain ? 'draining' : 'active' }),
  })
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** `path` plus the non-empty `params` as a query string. */
export function withParams(path: string, params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && v !== '') search.set(k, String(v))
  const qs = search.toString()
  return qs ? `${path}?${qs}` : path
}

/** One GET, refetched when `path` changes or on `reload`. A null `path` fetches nothing. */
export function useAdminData<T>(path: string | null): {
  data: T | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [tick, setTick] = useState(0)
  const key = `${path}#${tick}`
  // `key` names the request `data` came from; loading = it is not the wanted one yet.
  const [state, setState] = useState<{ key: string | null; data: T | null; error: string | null }>({
    key: null,
    data: null,
    error: null,
  })
  useEffect(() => {
    if (path === null) return
    let live = true
    adminFetch<T>(path).then(
      (data) => live && setState({ key, data, error: null }),
      (err: unknown) => live && setState((s) => ({ ...s, key, error: errorText(err) })),
    )
    return () => {
      live = false
    }
  }, [path, key])
  return {
    data: state.data,
    error: state.error,
    loading: path !== null && state.key !== key,
    reload: useCallback(() => setTick((t) => t + 1), []),
  }
}

/**
 * A keyset-paged list (`Page<T>`) shown one page at a time with Previous / Next. The API has
 * only a forward cursor, so this keeps the cursors of the pages before. New `params` start
 * again from the first page; `reload` refetches the current page.
 */
export function useCursorPages<T>(
  path: string | null,
  params: Record<string, string | number | null | undefined>,
): {
  items: T[]
  /** 1-based number of the page on screen. */
  page: number
  hasPrev: boolean
  hasNext: boolean
  loading: boolean
  error: string | null
  next: () => void
  prev: () => void
  reload: () => void
} {
  const base = path === null ? null : withParams(path, params)
  // Cursors of the pages on the way to the current one; [null] = first page.
  const [trail, setTrail] = useState<{ base: string | null; cursors: (string | null)[] }>({
    base,
    cursors: [null],
  })
  const cursors = trail.base === base ? trail.cursors : [null]
  if (trail.base !== base) setTrail({ base, cursors })
  const cursor = cursors[cursors.length - 1] ?? null
  const url = path === null ? null : withParams(path, { ...params, cursor })
  const { data, error, loading, reload } = useAdminData<Page<T>>(url)

  return {
    items: data?.items ?? EMPTY,
    page: cursors.length,
    hasPrev: cursors.length > 1,
    hasNext: !loading && data?.nextCursor != null,
    loading,
    error,
    next: () => {
      const n = data?.nextCursor
      if (n && !loading) setTrail({ base, cursors: [...cursors, n] })
    },
    prev: () => setTrail({ base, cursors: cursors.length > 1 ? cursors.slice(0, -1) : cursors }),
    reload,
  }
}
const EMPTY: never[] = []
