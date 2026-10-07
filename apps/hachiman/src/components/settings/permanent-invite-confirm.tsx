import { useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Warning } from '@/components/security/screen-window'

/**
 * The warning that an administrator must accept before Takusen makes a permanent invite (contract
 * §4 "Invite limits"). `onConfirm` creates the invite with `acknowledgedPermanent: true`; its
 * errors show in this window. `scope`: the channels of an invite with history, else null.
 */
export function PermanentInviteConfirm({
  open,
  onClose,
  onConfirm,
  scope = null
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => Promise<void>
  scope?: readonly string[] | null
}): React.JSX.Element {
  const checkId = useId()
  const [ack, setAck] = useState(false)
  // Also when the parent closes the window, e.g. after a loss of ADMINISTRATOR.
  if (!open && ack) setAck(false)

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Create a permanent invite?"
      body={
        <div className="grid gap-3">
          <Warning tone="danger">
            A permanent invite never expires. Anyone who gets this link, now or later, can join the
            guild. A link in a public place, a forwarded message or a screenshot can let unknown
            people in. Revoke the invite when you do not need it.
          </Warning>
          {scope && (
            <Warning tone="danger">
              Anyone who gets this link can also read the history and pages of these channels:{' '}
              {scope.join(', ')}. This continues until you revoke the invite. History that someone
              read before the revoke stays read.
            </Warning>
          )}
          <label htmlFor={checkId} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={checkId}
              className="mt-0.5"
              checked={ack}
              onChange={(e) => setAck(e.target.checked)}
            />
            I understand that anyone with this link can join until I revoke it.
          </label>
        </div>
      }
      confirmLabel="Create permanent invite"
      what="create a permanent invite"
      tone="danger"
      confirmDisabled={!ack}
      onConfirm={onConfirm}
    />
  )
}
