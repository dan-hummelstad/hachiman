'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Page } from '@/lib/admin'

/**
 * Client kit for the admin console. Every view reads and writes through /api/admin
 * (contract §4 Admin API), so the console and the API cannot drift apart.
 */

/** Calls /api/admin`path` with the dashboard cookie. Throws the envelope's message on failure. */
export async function adminFetch<T = void>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(`/api/admin${path}`, { ...init, headers })
  if (res.status === 204) return undefined as T
  const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null
  if (!res.ok) throw new Error(body?.message ?? body?.error ?? `HTTP ${res.status}`)
  return body as T
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useAdminData<T>(path: string): {
  data: T | null
  error: string | null
  reload: () => void
} {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    adminFetch<T>(path).then(
      (data) => live && setState({ data, error: null }),
      (err: unknown) => live && setState((s) => ({ ...s, error: errorText(err) })),
    )
    return () => {
      live = false
    }
  }, [path, tick])
  return { ...state, reload: useCallback(() => setTick((t) => t + 1), []) }
}

/** A cursor-paged list (`Page<T>`) filtered by `query`. A new query starts from the first page. */
export function usePagedList<T>(path: string, query: string): {
  items: T[]
  more: boolean
  loading: boolean
  error: string | null
  loadMore: () => void
  reload: () => void
} {
  const [tick, setTick] = useState(0)
  // `key` names the first page that `items` came from; loading = it is not the wanted one yet.
  const key = `${path}?${query}#${tick}`
  const [state, setState] = useState<{
    key: string | null
    items: T[]
    cursor: string | null
    error: string | null
  }>({ key: null, items: [], cursor: null, error: null })
  const [loadingMore, setLoadingMore] = useState(false)

  const fetchPage = useCallback(
    (after: string | null) => {
      const params = new URLSearchParams()
      if (query) params.set('query', query)
      if (after) params.set('cursor', after)
      return adminFetch<Page<T>>(`${path}?${params}`)
    },
    [path, query],
  )

  useEffect(() => {
    let live = true
    fetchPage(null).then(
      (page) =>
        live && setState({ key, items: page.items, cursor: page.nextCursor, error: null }),
      (err: unknown) => live && setState((s) => ({ ...s, key, error: errorText(err) })),
    )
    return () => {
      live = false
    }
  }, [fetchPage, key])

  const loadMore = (): void => {
    if (!state.cursor || state.key !== key) return
    // A new query or a reload while this page loads makes it stale: drop it.
    const fresh = (s: typeof state): boolean => s.key === key
    setLoadingMore(true)
    fetchPage(state.cursor)
      .then(
        (page) =>
          setState((s) =>
            fresh(s) ? { ...s, items: [...s.items, ...page.items], cursor: page.nextCursor } : s,
          ),
        (err: unknown) => setState((s) => (fresh(s) ? { ...s, error: errorText(err) } : s)),
      )
      .finally(() => setLoadingMore(false))
  }

  return {
    items: state.items,
    more: state.cursor !== null,
    loading: state.key !== key || loadingMore,
    error: state.error,
    loadMore,
    reload: useCallback(() => setTick((t) => t + 1), []),
  }
}

/** Search input that reports its value 250 ms after the last keystroke. */
export function SearchBox({
  label,
  onSearch,
}: {
  label: string
  onSearch: (query: string) => void
}): React.JSX.Element {
  const [value, setValue] = useState('')
  useEffect(() => {
    const t = setTimeout(() => onSearch(value.trim()), 250)
    return () => clearTimeout(t)
  }, [value, onSearch])
  return (
    <Input
      type="search"
      aria-label={label}
      placeholder={label}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      className="sm:max-w-80"
    />
  )
}

/**
 * A button that asks first: a window with the consequence, then the confirm action. Shows the
 * API error inside the window; on success it closes, toasts `done` and calls `onDone`.
 */
export function ConfirmAction({
  label,
  title,
  body,
  confirmLabel,
  done,
  destructive,
  size = 'sm',
  action,
  onDone,
}: {
  label: ReactNode
  title: string
  body: ReactNode
  confirmLabel: string
  done: string
  destructive?: boolean
  size?: 'sm' | 'xs' | 'default'
  action: () => Promise<unknown>
  onDone?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      setOpen(false)
      toast.success(done)
      onDone?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size={size}
        className={
          destructive
            ? 'text-destructive hover:border-destructive hover:bg-destructive hover:text-destructive-foreground'
            : undefined
        }
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        {label}
      </Button>
      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogDescription asChild>
            <div className="text-sm text-foreground">{body}</div>
          </DialogDescription>
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant={destructive ? 'destructive' : 'default'}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

/** Error line, empty state, table frame and "Load more" around a list. */
export function ListFrame({
  error,
  empty,
  isEmpty,
  loading,
  more,
  onMore,
  children,
}: {
  error: string | null
  empty: string
  isEmpty: boolean
  loading?: boolean
  more?: boolean
  onMore?: () => void
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="border border-destructive px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {isEmpty && !loading ? (
        <div className="border bg-card px-4 py-6 text-sm text-muted-foreground">{empty}</div>
      ) : (
        <div className="overflow-x-auto border">{children}</div>
      )}
      {more && (
        <Button variant="outline" className="self-start" disabled={loading} onClick={onMore}>
          {loading ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
export const formatDate = (iso: string): string => dateFmt.format(new Date(iso))
export const formatDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso))

export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
