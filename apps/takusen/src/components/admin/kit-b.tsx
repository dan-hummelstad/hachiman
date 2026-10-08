'use client'

import { CheckIcon, CircleAlertIcon, CopyIcon, EllipsisIcon, XIcon } from 'lucide-react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useState, type ReactNode } from 'react'
import { toast } from 'sonner'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { errorText } from './kit'

/**
 * Admin building blocks that kit.tsx does not have yet (page head, list states, row menu,
 * controlled confirm, meter, copy, relative time, the ⌘K `?query=` filter). Generic on purpose:
 * they move into kit.tsx.
 */

/** The `?query=` that ⌘K puts on a list page, and a way to drop it from the URL. */
export function useListQuery(): { query: string; clear: () => void } {
  const params = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const query = params.get('query')?.trim() ?? ''
  const clear = useCallback(() => {
    const next = new URLSearchParams(params)
    next.delete('query')
    const qs = next.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname)
  }, [params, pathname, router])
  return { query, clear }
}

/** Case-insensitive substring match of `query` against any of the fields. An empty query matches. */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  if (!query) return true
  const q = query.toLowerCase()
  return fields.some((f) => f?.toLowerCase().includes(q))
}

/** The active `?query=` as a selected chip; its × clears it. */
export function QueryChip({ query, onClear }: { query: string; onClear: () => void }): React.JSX.Element {
  return (
    <Chip selected onClick={onClear} aria-label={`Clear filter “${query}”`} title="Clear filter">
      <span className="max-w-40 truncate">“{query}”</span>
      <XIcon aria-hidden />
    </Chip>
  )
}

/** The ⋯ button at the end of a row; destructive items live here, behind a ConfirmDialog. */
export function RowMenu({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant="quiet" size="icon" aria-label={label}>
          <EllipsisIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * A controlled "are you sure" window, for actions started from a menu. Shows the API error
 * inside; on success it closes, toasts `done` and calls `onDone`.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel,
  done,
  destructive,
  action,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  body: ReactNode
  confirmLabel: string
  done: string
  destructive?: boolean
  action: () => Promise<unknown>
  onDone?: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
      onOpenChange(false)
      toast.success(done)
      onDone?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (busy) return
        setError(null)
        onOpenChange(o)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogDescription asChild>
          <div>{body}</div>
        </DialogDescription>
        {error && (
          <p role="alert" className="text-[13px] font-semibold text-feature-danger-text">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="quiet" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant={destructive ? 'danger' : 'primary'} disabled={busy} onClick={() => void confirm()}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** A value over a 96×6 square track, with the value as text above it. */
export function Meter({
  label,
  fraction,
  tone,
  muted,
}: {
  label: ReactNode
  fraction: number
  tone: 'voice' | 'thread' | 'event'
  muted?: boolean
}): React.JSX.Element {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100)
  return (
    <div className="flex flex-col gap-[5px]">
      <span
        className={cn('text-[13px] leading-4 font-bold tabular-nums', muted ? 'text-text-tertiary' : 'text-text-primary')}
      >
        {label}
      </span>
      <span aria-hidden className="block h-1.5 w-24 bg-surface-raised">
        <span
          className={cn(
            'block h-full',
            tone === 'voice' && 'bg-feature-voice',
            tone === 'thread' && 'bg-feature-thread',
            tone === 'event' && 'bg-feature-event',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
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

/** "3 s ago", "4 min ago", "2 h ago", "5 d ago". */
export function timeAgo(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s} s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h} h ago`
  return `${Math.floor(h / 24)} d ago`
}

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

/** Error banner, then a loading or empty panel in place of the list, else the list. */
export function ListState({
  error,
  loading,
  empty,
  children,
}: {
  error: string | null
  loading: boolean
  /** The empty-state text, or null when there are rows. */
  empty: ReactNode | null
  children: ReactNode
}): React.JSX.Element {
  return (
    <>
      {error && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Could not load this list</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {loading ? (
        <div className="border border-line-hairline bg-surface-panel px-[18px] py-6 text-[13.5px] text-text-tertiary">
          Loading…
        </div>
      ) : empty !== null ? (
        error ? null : (
          <div className="border border-line-hairline bg-surface-panel px-[18px] py-6 text-[13.5px] text-text-tertiary">
            {empty}
          </div>
        )
      ) : (
        children
      )}
    </>
  )
}
