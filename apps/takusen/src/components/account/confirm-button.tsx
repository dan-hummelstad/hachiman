'use client'

import { useState, useTransition, type ReactNode } from 'react'
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

export interface ActionResult {
  ok: boolean
  error?: string
}

/** Runs a server action that returns `{ ok, error }` and toasts the result. */
export function useResultAction(): {
  pending: boolean
  run: (action: () => Promise<ActionResult>, done: string) => void
} {
  const [pending, start] = useTransition()
  const run = (action: () => Promise<ActionResult>, done: string): void => {
    start(async () => {
      const res = await action().catch(() => ({ ok: false, error: 'Something went wrong. Try again.' }))
      if (res.ok) {
        toast.success(done)
      } else {
        toast.error(res.error ?? 'Something went wrong. Try again.')
      }
    })
  }
  return { pending, run }
}

/** A trigger button and a confirm window for a destructive account action. */
export function ConfirmButton({
  trigger,
  title,
  body,
  confirmLabel,
  done,
  action,
  onDone,
}: {
  /** Render the trigger with the given click handler. */
  trigger: (open: () => void) => ReactNode
  title: string
  body: ReactNode
  confirmLabel: string
  done: string
  action: () => Promise<ActionResult>
  onDone?: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()

  const confirm = (): void => {
    setError(null)
    start(async () => {
      const res = await action().catch(() => ({ ok: false, error: 'Something went wrong. Try again.' }))
      if (res.ok) {
        setOpen(false)
        toast.success(done)
        onDone?.()
      } else {
        setError(res.error ?? 'Something went wrong. Try again.')
      }
    })
  }

  return (
    <>
      {trigger(() => {
        setError(null)
        setOpen(true)
      })}
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{body}</DialogDescription>
          </DialogHeader>
          {error && (
            <p role="alert" className="text-[13px] font-semibold text-feature-danger-text">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button variant="quiet" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending} onClick={confirm}>
              {pending ? 'Working…' : confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
