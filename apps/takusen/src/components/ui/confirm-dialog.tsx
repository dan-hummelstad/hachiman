'use client'

import { CircleCheckIcon, type LucideIcon } from 'lucide-react'
import { useCallback, useState, type ReactNode } from 'react'
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
import { cn } from '@/lib/utils'

/** Turns a server action's `{ ok, error }` result into a throw, for `ConfirmSpec.action`. */
export async function orThrow(result: Promise<{ ok: boolean; error?: string }>): Promise<void> {
  const res = await result
  if (!res.ok) throw new Error(res.error ?? 'Something went wrong. Try again.')
}

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
function ConfirmDialog({
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
      setError(err instanceof Error ? err.message : 'Something went wrong. Try again.')
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
