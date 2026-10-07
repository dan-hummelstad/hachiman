import { useState } from 'react'
import { MessageSquareText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { ModalWindow } from '@/components/ui/modal-window'
import { NativeSelect } from '@/components/ui/native-select'
import { useCustomStatus } from '@/hooks/use-custom-status'
import {
  CLEAR_AFTER_OPTIONS,
  CUSTOM_STATUS_MAX,
  clearAfterToExpiresAt,
  type ClearAfter
} from '@/lib/custom-status'
import { cn } from '@/lib/utils'
import { setCustomStatus } from '@/services/guild-features'

/**
 * "Set a status" (N16): a short text that the people who share a guild or a DM with me see, and
 * when it clears. Plaintext, like presence.
 */
export function CustomStatusDialog({
  userId,
  open,
  onClose
}: {
  userId: string
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  return (
    <ModalWindow
      open={open}
      onClose={onClose}
      title="Set a status"
      description="People who share a guild or a DM with you see it next to your name."
      icon={<MessageSquareText />}
    >
      {/* Mounted only while open, so the form starts from the current status each time. */}
      {open && <StatusForm userId={userId} onClose={onClose} />}
    </ModalWindow>
  )
}

function StatusForm({
  userId,
  onClose
}: {
  userId: string
  onClose: () => void
}): React.JSX.Element {
  const current = useCustomStatus(userId)
  const [text, setText] = useState(current?.text ?? '')
  const [clearAfter, setClearAfter] = useState<ClearAfter>('never')
  const left = CUSTOM_STATUS_MAX - text.length

  const save = (): void => {
    const trimmed = text.trim()
    setCustomStatus(trimmed, trimmed ? clearAfterToExpiresAt(clearAfter, new Date()) : null)
    onClose()
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        save()
      }}
    >
      <Field id="custom-status-text" label="Status">
        <div className="relative">
          <Input
            id="custom-status-text"
            autoFocus
            value={text}
            maxLength={CUSTOM_STATUS_MAX}
            placeholder="What's happening?"
            onChange={(e) => setText(e.target.value)}
            className="pr-12"
          />
          <span
            aria-live="polite"
            className={cn(
              'pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs tabular-nums',
              left <= 8 ? 'text-feature-event-text' : 'text-text-tertiary'
            )}
          >
            {left}
          </span>
        </div>
      </Field>
      <Field id="custom-status-clear" label="Clear after">
        <NativeSelect
          id="custom-status-clear"
          value={clearAfter}
          onChange={(e) => setClearAfter(e.target.value as ClearAfter)}
        >
          {CLEAR_AFTER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <DialogFooter>
        {current && (
          <Button
            type="button"
            variant="quiet"
            className="sm:mr-auto"
            onClick={() => {
              setCustomStatus('', null)
              onClose()
            }}
          >
            Clear status
          </Button>
        )}
        <Button type="button" variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!text.trim() && !current}>
          Save
        </Button>
      </DialogFooter>
    </form>
  )
}
