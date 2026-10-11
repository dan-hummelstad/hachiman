import { Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface SaveBarProps {
  dirty: boolean
  /** Shows "Changes saved." while nothing is dirty. */
  saved?: boolean
  busy: boolean
  /** Save stays off (e.g. an empty name). */
  disabled?: boolean
  onReset: () => void
  onSave?: () => void
  /**
   * `bar` (default): one row in the page. `foot`: the docked foot of a mobile screen (M48, M52),
   * sticky at the bottom of the scrolling body. Put it last in the form, at the form's full width.
   */
  layout?: 'bar' | 'foot'
}

/**
 * The foot of an editable settings page: "You have unsaved changes" in gold, Reset and the primary
 * Save. Save is a submit button unless `onSave` is given.
 */
export function SaveBar(props: SaveBarProps): React.JSX.Element {
  if (props.layout === 'foot') return <SaveFoot {...props} />
  const { dirty, saved, busy, disabled, onReset, onSave } = props
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

/**
 * The mobile Save foot (M48): on the content colour with a top hairline, padding 12/16/6/16, gap
 * 10. The status line (a gold dot and "You have unsaved changes", 13.5/600) with Reset (14/700, a
 * 36 hit area) on its right, then the 48 primary Save, then the home-indicator inset. The empty
 * status line takes no room, but its live region (the status text, not Reset) stays in the DOM.
 * The foot sticks to the bottom of the screen's scrolling body and spans its 16 px padding.
 */
function SaveFoot({
  dirty,
  saved,
  busy,
  disabled,
  onReset,
  onSave
}: SaveBarProps): React.JSX.Element {
  return (
    <div
      data-slot="save-foot"
      className="bg-surface-content border-line-hairline sticky bottom-0 z-10 -mx-4 flex flex-col gap-2.5 border-t px-4 pt-3 pb-[calc(6px+var(--safe-bottom,0px))] in-data-[keyboard=open]:pb-1.5"
    >
      <div className={cn('flex min-h-7 items-center gap-2', !dirty && !saved && '-mb-2.5 min-h-0')}>
        {/* The live region holds only the status text, and stays mounted while it is empty. */}
        <span role="status" className="flex min-w-0 flex-1 items-center gap-2">
          {dirty ? (
            <>
              <span aria-hidden className="bg-feature-event size-[7px] shrink-0 rounded-full" />
              <span className="text-feature-event-text flex-1 text-[13.5px] leading-4 font-semibold">
                You have unsaved changes
              </span>
            </>
          ) : (
            saved && (
              <span className="text-text-tertiary text-[13.5px] leading-4 font-semibold">
                Changes saved.
              </span>
            )
          )}
        </span>
        {dirty && (
          <button
            type="button"
            disabled={busy}
            onClick={onReset}
            className="text-text-secondary active:text-text-primary focus-visible:outline-line-focus relative flex h-7 shrink-0 items-center px-1 text-[14px] leading-4 font-bold outline-none after:absolute after:-inset-1 focus-visible:outline-2 disabled:opacity-50"
          >
            Reset
          </button>
        )}
      </div>
      <Button
        type={onSave ? 'button' : 'submit'}
        size="mobile"
        disabled={busy || disabled || !dirty}
        onClick={onSave}
      >
        <Check /> {busy ? 'Saving…' : 'Save changes'}
      </Button>
    </div>
  )
}
