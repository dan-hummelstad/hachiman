import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The foot of an editable settings page: "You have unsaved changes" in gold, Reset and the primary
 * Save. Save is a submit button unless `onSave` is given.
 */
export function SaveBar({
  dirty,
  saved,
  busy,
  disabled,
  onReset,
  onSave
}: {
  dirty: boolean
  /** Shows "Changes saved." while nothing is dirty. */
  saved?: boolean
  busy: boolean
  /** Save stays off (e.g. an empty name). */
  disabled?: boolean
  onReset: () => void
  onSave?: () => void
}): React.JSX.Element {
  return (
    <div className="flex min-h-9 items-center gap-2">
      <span role="status" className="flex-1 text-[13px] font-semibold">
        {dirty ? (
          <span className="text-feature-event-text">You have unsaved changes</span>
        ) : (
          saved && <span className="text-text-tertiary">Changes saved.</span>
        )}
      </span>
      {dirty && (
        <Button type="button" variant="quiet" disabled={busy} onClick={onReset}>
          Reset
        </Button>
      )}
      <Button
        type={onSave ? 'button' : 'submit'}
        size="lg"
        disabled={busy || disabled || !dirty}
        onClick={onSave}
      >
        <Check /> {busy ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  )
}
