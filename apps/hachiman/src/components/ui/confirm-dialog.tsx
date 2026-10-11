import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { ErrorText } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'

interface ConfirmDialogProps {
  open: boolean
  title: string
  /** The subtitle under the title ("Text channel · Night Owls"). */
  description?: string
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
  /** Where the focus goes on close; `preventDefault` keeps Radix from moving it. */
  onCloseAutoFocus?: (event: Event) => void
}

/**
 * "Are you sure?" window: Cancel + one confirm button, busy while `onConfirm` runs. On the mobile
 * layout it stays a centred card (M50, M51), with Cancel and the confirm button side by side.
 */
export function ConfirmDialog(props: ConfirmDialogProps): React.JSX.Element {
  return (
    <ModalWindow
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      description={props.description}
      presentation="dialog"
      icon={props.icon}
      feature={props.tone === 'danger' ? 'danger' : 'accent'}
      onCloseAutoFocus={props.onCloseAutoFocus}
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
  const mobile = useLayout() === 'mobile'

  const confirm = async (): Promise<void> => {
    if ((await run(props.what ?? confirmLabel.toLowerCase(), onConfirm)).ok) onClose()
  }

  return (
    <>
      <div className="text-sm">{body}</div>
      <ErrorText>{error}</ErrorText>
      <DialogFooter>
        <Button variant={mobile ? 'secondary' : 'quiet'} disabled={busy} onClick={onClose}>
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
