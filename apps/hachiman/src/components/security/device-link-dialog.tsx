import { useState } from 'react'
import { Check, MonitorSmartphone, ScanLine, Smile, X } from 'lucide-react'
import { LINK_QR_PREFIX } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ErrorText } from '@/components/ui/field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { SelectableRow } from '@/components/ui/selectable-row'
import { cryptoErrorText } from '@/components/security/errors'
import { LinkAsNewDevice, Waiting } from '@/components/security/link-new-device'
import { ScanOrPaste } from '@/components/security/qr-view'
import { SasEmojiRow } from '@/components/security/sas-emoji'
import { StepFrame } from '@/components/security/screen-window'
import { useLayout } from '@/hooks/use-layout'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { useDialog } from '@/stores/dialogStore'
import { Callout } from '@/components/ui/callout'
import { DeviceLinkSheet } from '@/components/security/device-link-sheet'
import {
  useExistingDeviceLink,
  useLinkSessions,
  type PendingSession
} from '@/components/security/use-device-link'

/**
 * Dialog kind 'deviceLink' (§12.5). Existing device: scan or paste the QR code of the new device,
 * or accept its request and compare the 7 emoji. The keys go to the new device only after the
 * scan, or after the user confirms that the emoji match. New device: the same flow as onboarding.
 * On the mobile layout the existing device's side is the M22 to M24 sheet.
 */
export function DeviceLinkDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('deviceLink')
  const mobile = useLayout() === 'mobile'
  if (mobile && dialog.role === 'existing_device') {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && close()}>
        <DeviceLinkSheet initialSessionId={dialog.sessionId} onClose={close} />
      </Dialog>
    )
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent aria-describedby={undefined} className="sm:max-w-[560px]">
        {dialog.role === 'existing_device' ? (
          <LinkFromThisDevice initialSessionId={dialog.sessionId} onClose={close} />
        ) : (
          <LinkAsNewDevice onBack={close} />
        )}
      </DialogContent>
    </Dialog>
  )
}

const FRAME = {
  icon: <MonitorSmartphone />,
  title: 'Link a new device',
  subtitle: 'From this device'
} as const

const MODES = [
  { value: 'qr', label: 'Scan the code', icon: <ScanLine /> },
  { value: 'sas', label: 'Compare emoji', icon: <Smile /> }
] as const

function LinkFromThisDevice({
  initialSessionId,
  onClose
}: {
  initialSessionId: string | null
  onClose: () => void
}): React.JSX.Element {
  const { mode, setMode, active, sas, done, busy, error, scan, accept, confirm, restart } =
    useExistingDeviceLink(initialSessionId)

  if (done) {
    return (
      <StepFrame
        {...FRAME}
        icon={done.ok ? <Check /> : FRAME.icon}
        feature={done.ok ? 'voice' : 'danger'}
        footer={
          <>
            {!done.ok && (
              <Button variant="quiet" onClick={restart}>
                Try again
              </Button>
            )}
            <Button onClick={onClose}>Done</Button>
          </>
        }
      >
        {done.ok ? (
          <p role="status">
            <b>{active?.name}</b> is linked. It gets your messages now.
          </p>
        ) : (
          <ErrorText>{`The link did not finish: ${cryptoErrorText({ code: done.error })}`}</ErrorText>
        )}
      </StepFrame>
    )
  }

  if (active) {
    return (
      <StepFrame
        {...FRAME}
        footer={
          <>
            <Button variant="quiet" className={sas ? 'sm:mr-auto' : undefined} onClick={restart}>
              Cancel
            </Button>
            {sas && (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => void confirm(false)}>
                  <X /> They do not match
                </Button>
                <Button disabled={busy} onClick={() => void confirm(true)}>
                  <Check /> They match
                </Button>
              </>
            )}
          </>
        }
      >
        {sas ? (
          <>
            <p>
              Compare these emoji with the emoji on <b>{active.name}</b>. They must be the same, in
              the same order.
            </p>
            <SasEmojiRow emoji={sas.emoji} />
          </>
        ) : (
          <Waiting>
            {mode === 'sas' ? `Waiting for ${active.name}…` : `Sending the keys to ${active.name}…`}
          </Waiting>
        )}
        <ErrorText>{error}</ErrorText>
      </StepFrame>
    )
  }

  return (
    <StepFrame
      {...FRAME}
      footer={
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <Callout tone="caution">
        Link only a device that you have with you now. A linked device can read all of your
        messages.
      </Callout>
      <SegmentedControl
        label="How to link"
        options={MODES}
        value={mode}
        onChange={setMode}
        className="flex w-full"
      />
      {mode === 'qr' ? (
        <>
          <p>
            On the new device, select <b>Link from another device</b> and then <b>Show a QR code</b>
            . Scan the code here, or copy its text there and paste it below.
          </p>
          <ScanOrPaste prefix={LINK_QR_PREFIX} busy={busy} onCode={(c) => void scan(c)} />
        </>
      ) : (
        <SessionPicker
          initialSessionId={initialSessionId}
          busy={busy}
          onPick={(s) => void accept(s)}
        />
      )}
      <ErrorText>{error}</ErrorText>
    </StepFrame>
  )
}

/** The open link requests of the account (SAS mode). */
function SessionPicker({
  initialSessionId,
  busy,
  onPick
}: {
  initialSessionId: string | null
  busy: boolean
  onPick: (s: PendingSession) => void
}): React.JSX.Element {
  const { sessions, error, reload } = useLinkSessions()
  const [selected, setSelected] = useState<string | null>(initialSessionId)

  const pick = sessions?.find((s) => s.sessionId === selected) ?? null
  return (
    <div className="grid gap-3">
      <p>
        On the new device, select <b>Link from another device</b> and then <b>Compare emoji</b>.
        Then select the device here.
      </p>
      <ErrorText>{error}</ErrorText>
      {sessions?.length === 0 && <p className="text-text-tertiary">No device asks to link now.</p>}
      {sessions && sessions.length > 0 && (
        <ul className="border-line-hairline grid border">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <SelectableRow
                selected={s.sessionId === selected}
                onClick={() => setSelected(s.sessionId)}
              >
                <span className="truncate">{s.newDeviceName}</span>
                <span className="text-text-tertiary ml-auto shrink-0 text-xs">
                  {PLATFORM_LABEL[s.platform]} · {new Date(s.createdAt).toLocaleTimeString()}
                </span>
              </SelectableRow>
            </li>
          ))}
        </ul>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="quiet" onClick={reload}>
          Look again
        </Button>
        <Button disabled={busy || !pick} onClick={() => pick && onPick(pick)}>
          Continue
        </Button>
      </div>
    </div>
  )
}
