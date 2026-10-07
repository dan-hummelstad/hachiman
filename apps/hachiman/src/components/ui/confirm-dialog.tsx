import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { ErrorText } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { useAction } from '@/hooks/use-action'

interface ConfirmDialogProps {
  open: boolean
  title: string
  body: React.ReactNode
  confirmLabel: string
  tone?: 'default' | 'danger'
  /** Icon in the header tile; the tile is red for `tone="danger"`. */
  icon?: React.ReactNode
  /** Awaited; the window closes on success and shows the error inline on failure. */
  onConfirm: () => Promise<void>
  onClose: () => void
  /** Error phrasing, "Could not <what>: …". Defaults to the lower-cased confirm label. */
  what?: string
  /** Keeps the confirm button disabled (e.g. until a type-to-confirm field matches). */
  confirmDisabled?: boolean
}

/** "Are you sure?" window: Cancel + one confirm button, busy while `onConfirm` runs. */
export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element {
  return (
    <ModalWindow
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      icon={props.icon}
      feature={props.tone === 'danger' ? 'danger' : 'accent'}
    >
      <ConfirmBody {...props} />
    </ModalWindow>
  )
}

/**
 * Lives inside the window's content, which unmounts once the window has closed, so busy/error
 * start fresh on every open.
 */
function ConfirmBody(props: ConfirmDialogProps): React.JSX.Element {
  const { body, confirmLabel, tone = 'default', onConfirm, onClose } = props
  const { run, busy, error } = useAction()

  const confirm = async (): Promise<void> => {
    if ((await run(props.what ?? confirmLabel.toLowerCase(), onConfirm)).ok) onClose()
  }

  return (
    <>
      <div className="text-sm">{body}</div>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button variant="quiet" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant={tone === 'danger' ? 'danger' : 'primary'}
          disabled={busy || props.confirmDisabled}
          onClick={() => void confirm()}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </>
  )
}
