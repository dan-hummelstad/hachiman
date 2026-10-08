'use client'

import {
  AlertTriangleIcon,
  EllipsisIcon,
  InboxIcon,
  RotateCwIcon,
  SearchIcon,
  XIcon,
  type LucideIcon,
} from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useConfirm, type ConfirmSpec } from '@/components/ui/confirm-dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Client kit for the admin console (F1–F8): toolbar, states, pagination, row menu and cells.
 * The data hooks are in data.ts. List state that a link can set (`?query=`, `?filter=`) lives
 * in the URL: the ⌘K palette and the overview land on a filtered list, and the search field in
 * the page head talks to the list through it.
 */

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
