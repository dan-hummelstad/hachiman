'use client'

import {
  AlertTriangleIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  EllipsisIcon,
  InboxIcon,
  RotateCwIcon,
  SearchIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { initialsFor } from '@/components/initials'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { Page } from '@/lib/admin'
import { fileUrl } from '@/lib/file-url'
import { cn } from '@/lib/utils'

/**
 * Client kit for the admin console (F1–F8). Every view reads and writes through /api/admin
 * (contract §4 Admin API), so the console and the API cannot drift apart. List state that a
 * link can set (`?query=`, `?filter=`) lives in the URL: the ⌘K palette and the overview land
 * on a filtered list, and the search field in the page head talks to the list through it.
 */

// MARK: - Data

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
  const url = base === null ? null : base + (cursor ? `${base.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : '')
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

/**
 * One URL search param as state. `set` replaces the history entry (no scroll), so typing in a
 * search field does not fill the back button. `null` or '' removes the param.
 */
export function useSearchParamState(name: string): [string, (value: string | null) => void] {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const value = params.get(name) ?? ''
  const set = useCallback(
    (next: string | null) => {
      const current = new URLSearchParams(window.location.search)
      if ((current.get(name) ?? '') === (next ?? '')) return
      if (next) current.set(name, next)
      else current.delete(name)
      const qs = current.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [name, pathname, router],
  )
  return [value, set]
}

/** Case-insensitive substring match of `query` against any of the fields, for lists the API does not search. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return fields.some((f) => f?.toLowerCase().includes(q))
}

// MARK: - Toolbar

/**
 * The page head of DashboardShell (title, description, actions bottom-right), for a client view
 * whose head actions share state with the list (filter chips, the Add dialog). Pass no title
 * to DashboardShell when you use it.
 */
export function PageHead({
  title,
  description,
  actions,
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <h1 className="text-page-title text-text-primary">{title}</h1>
        {description && <p className="text-body text-text-tertiary">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}


/**
 * The list search in the page head (F2, F3): writes `?query=` 250 ms after the last keystroke
 * and follows the URL when a link (⌘K) changes it. Render it as the shell's `actions`.
 */
export function SearchField({
  placeholder,
  param = 'query',
  className,
}: {
  placeholder: string
  param?: string
  className?: string
}): React.JSX.Element {
  const [query, setQuery] = useSearchParamState(param)
  const [value, setValue] = useState(query)
  // A new URL value (⌘K, back button) wins over what is typed.
  const [seen, setSeen] = useState(query)
  if (seen !== query) {
    setSeen(query)
    setValue(query)
  }
  useEffect(() => {
    const t = setTimeout(() => setQuery(value.trim()), 250)
    return () => clearTimeout(t)
  }, [value, setQuery])
  return (
    <Input
      type="search"
      aria-label={placeholder}
      placeholder={placeholder}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      leading={<SearchIcon aria-hidden />}
      className={cn('h-[38px] w-full text-[14.5px] sm:w-80', className)}
    />
  )
}

export interface FilterOption<V extends string> {
  value: V
  label: string
  /** Shown after the label; omit while unknown. */
  count?: number
}

/** Filter chips over a table (F2, F4): one is selected, the first option is "everything". */
export function FilterChips<V extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  /** Accessible name of the group, e.g. "Filter users". */
  label: string
  options: readonly FilterOption<V>[]
  value: V
  onChange: (value: V) => void
  className?: string
}): React.JSX.Element {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap items-center gap-2', className)}>
      {options.map((o) => (
        <Chip key={o.value} selected={o.value === value} count={o.count} onClick={() => onChange(o.value)}>
          {o.label}
        </Chip>
      ))}
    </div>
  )
}

/** `?filter=` (or `param`) as a typed chip value; anything unknown reads as the first option. */
export function useFilterParam<V extends string>(
  options: readonly V[],
  param = 'filter',
): [V, (value: V) => void] {
  const [raw, set] = useSearchParamState(param)
  const first = options[0] as V
  const value = (options as readonly string[]).includes(raw) ? (raw as V) : first
  return [value, useCallback((v: V) => set(v === first ? null : v), [first, set])]
}

/** The `?query=` a ⌘K link set on a list without a search field, as a selected chip; its × clears it. */
export function QueryChip({ param = 'query' }: { param?: string }): React.JSX.Element | null {
  const [query, setQuery] = useSearchParamState(param)
  if (!query.trim()) return null
  return (
    <Chip selected onClick={() => setQuery(null)} aria-label={`Clear filter “${query}”`} title="Clear filter">
      <span className="max-w-40 truncate">“{query}”</span>
      <XIcon aria-hidden />
    </Chip>
  )
}

// MARK: - Confirmation

export interface ConfirmSpec {
  title: string
  body: ReactNode
  confirmLabel: string
  /** Toast after success. */
  done: string
  /** Red confirm button. */
  destructive?: boolean
  confirmIcon?: LucideIcon
  /** Shown before the title (F7: the guild icon). */
  titleIcon?: ReactNode
  /** The confirm button stays disabled until this exact text is typed (F7). */
  typeToConfirm?: string
  /** Leading icon of the type-to-confirm input. */
  typeIcon?: LucideIcon
  action: () => Promise<unknown>
  onDone?: () => void
}

/**
 * The confirmation window (F7): square, the consequence in plain words, optionally a typed
 * name, Cancel + the action. Shows the API error inside; on success it closes, toasts `done`
 * and calls `onDone`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  spec,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  spec: ConfirmSpec | null
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [shown, setShown] = useState(spec)
  // Keep the last spec while the window fades out; reset the form for a new one.
  if (spec && spec !== shown) {
    setShown(spec)
    setTyped('')
    setError(null)
  }
  const s = spec ?? shown
  const matches = !s?.typeToConfirm || typed.trim() === s.typeToConfirm
  const TypeIcon = s?.typeIcon
  const ConfirmIcon = s?.confirmIcon

  const confirm = async (): Promise<void> => {
    if (!s || !matches) return
    setBusy(true)
    setError(null)
    try {
      await s.action()
      onOpenChange(false)
      toast.success(s.done)
      s.onDone?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[500px]">
        {s && (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault()
              void confirm()
            }}
          >
            <DialogHeader>
              <DialogTitle className="gap-3">
                {s.titleIcon}
                {s.title}
              </DialogTitle>
            </DialogHeader>
            <DialogDescription asChild>
              <div>{s.body}</div>
            </DialogDescription>
            {s.typeToConfirm && (
              <label className="flex flex-col gap-2">
                <span className="text-[13.5px] leading-5 font-bold text-text-primary">
                  Type {s.typeToConfirm} to confirm
                </span>
                <Input
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  leading={TypeIcon && <TypeIcon aria-hidden />}
                  trailing={
                    matches ? <CircleCheckIcon aria-label="Matches" className="text-feature-voice-text!" /> : undefined
                  }
                  className={cn(matches && 'border-gold-line')}
                />
              </label>
            )}
            {error && (
              <p role="alert" className="text-[13px] font-semibold text-feature-danger-text">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="quiet" disabled={busy} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" variant={s.destructive ? 'danger' : 'primary'} disabled={busy || !matches}>
                {ConfirmIcon && <ConfirmIcon aria-hidden />}
                {s.confirmLabel}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** `ConfirmDialog` state for one view: `ask(spec)` opens it. Render `dialog` once. */
export function useConfirm(): { ask: (spec: ConfirmSpec) => void; dialog: React.JSX.Element } {
  const [spec, setSpec] = useState<ConfirmSpec | null>(null)
  const [open, setOpen] = useState(false)
  const ask = useCallback((s: ConfirmSpec) => {
    setSpec(s)
    setOpen(true)
  }, [])
  return { ask, dialog: <ConfirmDialog open={open} onOpenChange={setOpen} spec={spec} /> }
}

/** A button that asks first (`ConfirmDialog`). */
export function ConfirmAction({
  label,
  icon: Icon,
  variant,
  size = 'sm',
  className,
  ...spec
}: Omit<ConfirmSpec, 'title'> & {
  title: string
  label: ReactNode
  icon?: LucideIcon
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-soft'
  size?: 'sm' | 'xs' | 'default'
  className?: string
}): React.JSX.Element {
  const { ask, dialog } = useConfirm()
  return (
    <>
      <Button
        variant={variant ?? (spec.destructive ? 'danger-soft' : 'secondary')}
        size={size}
        className={className}
        onClick={() => ask(spec)}
      >
        {Icon && <Icon aria-hidden />}
        {label}
      </Button>
      {dialog}
    </>
  )
}

// MARK: - Row menu

export interface RowMenuItem {
  label: string
  icon: LucideIcon
  /** Red, after a divider at the end of the menu. */
  destructive?: boolean
  /** Run directly… */
  onSelect?: () => void
  /** …or ask first. */
  confirm?: ConfirmSpec
}

/**
 * The ⋯ button at the end of a row (F2, F4, F5) and its menu. Destructive items go last,
 * after a divider, in red; an item with `confirm` opens the confirmation window.
 */
export function RowMenu({ label, items }: { label: string; items: readonly RowMenuItem[] }): React.JSX.Element {
  const { ask, dialog } = useConfirm()
  const safe = items.filter((i) => !i.destructive)
  const risky = items.filter((i) => i.destructive)
  const render = (i: RowMenuItem): React.JSX.Element => (
    <DropdownMenuItem
      key={i.label}
      variant={i.destructive ? 'destructive' : 'default'}
      className="gap-2.5"
      onSelect={() => {
        if (i.confirm) ask(i.confirm)
        else i.onSelect?.()
      }}
    >
      <i.icon aria-hidden className={i.destructive ? undefined : 'text-text-tertiary'} />
      {i.label}
    </DropdownMenuItem>
  )
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="quiet"
            size="icon"
            aria-label={label}
            className="border border-transparent text-text-secondary data-[state=open]:border-line-strong data-[state=open]:bg-surface-raised [&_svg]:text-text-secondary"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[236px]">
          {safe.map(render)}
          {safe.length > 0 && risky.length > 0 && <DropdownMenuSeparator className="mx-1.5 my-1" />}
          {risky.map(render)}
        </DropdownMenuContent>
      </DropdownMenu>
      {dialog}
    </>
  )
}

// MARK: - States

/** Error band with an optional retry, above or instead of a list. */
export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }): React.JSX.Element {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 border border-feature-danger/30 bg-feature-danger/10 px-4 py-3 text-[13.5px] text-feature-danger-text"
    >
      <AlertTriangleIcon aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 font-semibold">{message}</span>
      {onRetry && (
        <Button variant="quiet" size="sm" onClick={onRetry}>
          <RotateCwIcon aria-hidden />
          Retry
        </Button>
      )}
    </div>
  )
}

/** Empty list: a square panel with an icon tile, a line and an optional action. */
export function EmptyState({
  icon: Icon = InboxIcon,
  title,
  body,
  action,
  className,
}: {
  icon?: LucideIcon
  title: string
  body?: ReactNode
  action?: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-3 border border-line-hairline bg-surface-panel px-6 py-12 text-center',
        className,
      )}
    >
      <span className="flex size-[38px] items-center justify-center border border-line-hairline bg-surface-raised">
        <Icon aria-hidden className="size-[18px] text-text-tertiary" />
      </span>
      <div className="flex flex-col gap-1">
        <p className="text-[14.5px] font-bold text-text-primary">{title}</p>
        {body && <p className="text-[13px] text-text-tertiary">{body}</p>}
      </div>
      {action}
    </div>
  )
}

/** Placeholder rows while the first page loads: the table's 56px rhythm, no layout jump. */
export function LoadingRows({ rows = 4, className }: { rows?: number; className?: string }): React.JSX.Element {
  return (
    <div
      aria-busy
      aria-label="Loading"
      className={cn('flex flex-col gap-0.5 border border-line-hairline bg-surface-panel p-1.5 pt-[46px]', className)}
    >
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-14 items-center gap-2.5 px-4">
          <span className="size-8 shrink-0 animate-pulse rounded-full bg-surface-raised" />
          <span className="flex flex-1 flex-col gap-1.5">
            <span className="h-3 w-40 max-w-full animate-pulse bg-surface-raised" />
            <span className="h-2.5 w-56 max-w-full animate-pulse bg-surface-hover" />
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Error band, loading rows, empty state or the table, then the footer. `loading` with no rows
 * shows placeholders; with rows the table stays and dims, so paging does not jump.
 */
export function ListFrame({
  error,
  empty,
  emptyBody,
  emptyIcon,
  isEmpty,
  loading,
  onRetry,
  more,
  onMore,
  footer,
  children,
}: {
  error: string | null
  empty: string
  emptyBody?: ReactNode
  emptyIcon?: LucideIcon
  isEmpty: boolean
  loading?: boolean
  onRetry?: () => void
  /** "Load more" under the list (older lists); new lists pass a `Pagination` as `footer`. */
  more?: boolean
  onMore?: () => void
  footer?: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-3.5">
      {error && <ErrorBanner message={error} onRetry={onRetry} />}
      {isEmpty && loading ? (
        <LoadingRows />
      ) : isEmpty ? (
        !error && <EmptyState icon={emptyIcon} title={empty} body={emptyBody} />
      ) : (
        <div className={cn('transition-opacity', loading && 'opacity-60')}>{children}</div>
      )}
      {footer}
      {more && (
        <Button variant="secondary" size="sm" className="self-start" disabled={loading} onClick={onMore}>
          {loading ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </div>
  )
}

/** Table foot (F2): the count on the left, Previous · page · Next on the right. */
export function Pagination({
  summary,
  page,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  summary?: ReactNode
  page: number
  hasPrev: boolean
  hasNext: boolean
  onPrev: () => void
  onNext: () => void
}): React.JSX.Element {
  return (
    <nav aria-label="Pages" className="flex items-center gap-2 px-1 pt-1">
      <span className="min-w-0 flex-1 text-[13px] text-text-tertiary">{summary}</span>
      {(hasPrev || hasNext) && (
        <>
          <Button variant="secondary" size="sm" disabled={!hasPrev} onClick={onPrev}>
            Previous
          </Button>
          <span
            aria-current="page"
            className="flex size-8 items-center justify-center rounded-control border border-gold-line bg-gold-tint text-[13px] font-extrabold text-gold-text tabular-nums"
          >
            {page}
          </span>
          {hasNext && (
            <button
              type="button"
              onClick={onNext}
              className="flex size-8 items-center justify-center rounded-control text-[13px] font-bold text-text-secondary tabular-nums hover:bg-surface-hover"
            >
              {page + 1}
            </button>
          )}
          <Button variant="secondary" size="sm" disabled={!hasNext} onClick={onNext}>
            Next
          </Button>
        </>
      )}
    </nav>
  )
}

// MARK: - Cells

/** Round avatar or guild icon from an upload key, with initials when there is none. */
export function EntityAvatar({
  fileKey,
  name,
  email = '',
  size = 32,
  className,
}: {
  fileKey: string | null
  name: string
  email?: string
  size?: number
  className?: string
}): React.JSX.Element {
  const src = fileUrl(fileKey)
  return (
    <Avatar className={cn('rounded-full', className)} style={{ width: size, height: size }}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback
        className="rounded-full bg-surface-raised font-extrabold text-text-secondary"
        style={{ fontSize: Math.max(10, Math.round(size * 0.36)) }}
      >
        {initialsFor(name, email)}
      </AvatarFallback>
    </Avatar>
  )
}

/** Avatar + bold name (with tags after it) over a muted line: the first cell of a row. */
export function IdentityCell({
  avatar,
  name,
  tags,
  sub,
}: {
  avatar: ReactNode
  name: ReactNode
  tags?: ReactNode
  sub?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {avatar}
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-12 truncate text-sm leading-[18px] font-extrabold text-text-primary">{name}</span>
          {tags && <span className="flex shrink-0 items-center gap-2 max-sm:hidden">{tags}</span>}
        </div>
        {sub && <span className="truncate text-[12.5px] leading-4 font-medium text-text-tertiary">{sub}</span>}
      </div>
    </div>
  )
}

const DOT_TONES = {
  online: 'bg-status-online',
  offline: 'bg-status-offline',
  warning: 'bg-feature-event',
  info: 'bg-feature-thread',
  danger: 'bg-feature-danger',
} as const

/** 7px status dot (sessions, nodes of a region). */
export function Dot({
  tone,
  title,
  className,
}: {
  tone: keyof typeof DOT_TONES
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      title={title}
      className={cn('inline-block size-[7px] shrink-0 rounded-full', DOT_TONES[tone], className)}
    />
  )
}

const METER_TONES = {
  voice: 'bg-feature-voice',
  info: 'bg-feature-thread',
  warning: 'bg-feature-event',
  danger: 'bg-feature-danger',
  gold: 'bg-gold',
} as const

/** Square load bar (F1 voice per region, F4 sessions and CPU). `value / max`, clamped. */
export function Meter({
  value,
  max,
  tone = 'voice',
  label,
  className,
}: {
  value: number
  max: number
  tone?: keyof typeof METER_TONES
  label?: string
  className?: string
}): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('h-2 w-full bg-surface-raised', className)}
    >
      <div className={cn('h-full', METER_TONES[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}

/** Copies `value`; the icon turns into a check for a moment. */
export function CopyButton({ value, label }: { value: string; label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    navigator.clipboard.writeText(value).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      },
      () => toast.error('Could not copy to the clipboard.'),
    )
  }
  return (
    <Button variant="quiet" size="icon" aria-label={label} title={label} onClick={copy}>
      {copied ? <CheckIcon className="text-feature-voice-text" /> : <CopyIcon />}
    </Button>
  )
}

// MARK: - Format

const dateFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })
/** "27 Aug 2026" */
export const formatDate = (iso: string): string => dateFmt.format(new Date(iso))
/** "29 Sept" */
export const formatDay = (iso: string): string => dayFmt.format(new Date(iso))
export const formatDateTime = (iso: string): string => dateTimeFmt.format(new Date(iso))

const relFmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' })
/** "3 sec. ago", "4 min. ago", "in 6 days": the largest unit that fits. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const s = Math.round((new Date(iso).getTime() - now) / 1000)
  const a = Math.abs(s)
  if (a < 60) return relFmt.format(s, 'second')
  if (a < 3600) return relFmt.format(Math.round(s / 60), 'minute')
  if (a < 86400) return relFmt.format(Math.round(s / 3600), 'hour')
  return relFmt.format(Math.round(s / 86400), 'day')
}

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

/** "1 channel", "14 channels" */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}
