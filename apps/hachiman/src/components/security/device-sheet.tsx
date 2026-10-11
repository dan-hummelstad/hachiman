import { useCallback, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { AppWindow, Clock, Link, LogOut, Pencil } from 'lucide-react'
import type { DeviceSummary } from '@hachiman/crypto'
import { MobileField } from '@/components/mobile/field'
import { ListGroup, ListRow } from '@/components/mobile/list'
import { Sheet, SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import { RemoveDeviceBody } from '@/components/security/device-actions'
import {
  PRIMARY_ONLY,
  addedDay,
  addedText,
  lastActiveText,
  useRenameDevice,
  type RemoveReason
} from '@/components/security/device-model'
import { DeviceGlyph, deviceTileTone } from '@/components/security/device-tile'
import { friendly } from '@/components/security/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAction } from '@/hooks/use-action'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { cryptoService } from '@/services/CryptoService'
import { usePlatform } from '@/shared/PlatformContext'
import { openDialog } from '@/stores/dialogStore'

type Step = 'details' | 'rename' | 'signOut'

const TEXT = 'text-text-secondary text-sm leading-normal font-medium'
const NOTE = 'text-text-tertiary text-[13px] leading-normal font-medium'
const ALERT = 'text-feature-danger-text text-[13.5px] leading-[18px] font-semibold'

/**
 * The tile of the Sheet Header in the device's colour (`deviceTileTone`): a grey device has no
 * feature colour, so its tile takes the grey of `DeviceTile`.
 */
const NEUTRAL_HEADER_TILE = 'bg-surface-hover text-text-secondary'

/**
 * The details of one own device (M26) with its rename and sign-out steps in the same sheet:
 * "Last active", "Added" and "App" rows, a note, a quiet Rename and a red Sign out. Another device
 * signs out in the sheet and needs a device with the security key (`canRemove`). This device
 * signs out only through the M35 sheet (dialog kind `signOut`, spec E3), which says what brings
 * the history back and asks for a tick when nothing does.
 */
export function DeviceSheet({
  device,
  open,
  onOpenChange,
  canRemove,
  onChanged
}: {
  /** Keep the last device while the sheet slides out. */
  device: DeviceSummary | null
  open: boolean
  onOpenChange: (open: boolean) => void
  canRemove: boolean
  /** A rename or a sign-out finished: reload the list. */
  onChanged: () => void
}): React.JSX.Element {
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {device && (
        <SheetContent>
          <DeviceSheetSteps
            key={device.id}
            device={device}
            canRemove={canRemove}
            onChanged={onChanged}
            onClose={close}
          />
        </SheetContent>
      )}
    </Sheet>
  )
}

function DeviceSheetSteps({
  device,
  canRemove,
  onChanged,
  onClose
}: {
  device: DeviceSummary
  canRemove: boolean
  onChanged: () => void
  onClose: () => void
}): React.JSX.Element {
  const platform = usePlatform()
  const [step, setStep] = useState<Step>('details')
  const [now] = useState(Date.now)
  const [name, setName] = useState(device.name)
  const [reason, setReason] = useState<RemoveReason>('user')
  const nameField = useRef<HTMLInputElement>(null)
  const renaming = useRenameDevice(device, onChanged)
  const signOut = useAction()
  const formId = useId()
  const fieldId = useId()
  const noteId = useId()

  const canSignOut = device.current || canRemove
  const tone = deviceTileTone(device)
  const added = addedDay(device.createdAt, now)
  const label = PLATFORM_LABEL[device.platform]

  /** Show the field and focus it in the tap, so iOS raises the keyboard (spec §2.8). */
  const startRename = (): void => {
    flushSync(() => {
      setName(device.name)
      renaming.clearError()
      setStep('rename')
    })
    nameField.current?.focus()
  }
  const startSignOut = (): void => {
    if (device.current) {
      onClose()
      openDialog({ kind: 'signOut' })
      return
    }
    signOut.clearError()
    setReason('user')
    setStep('signOut')
    platform.haptic('warning')
  }
  const save = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    const result = await renaming.rename(name)
    if (result === 'failed') return
    if (result === 'renamed') platform.haptic('success')
    setStep('details')
  }
  const confirmSignOut = async (): Promise<void> => {
    const r = await signOut.run('sign out the device', () =>
      friendly(cryptoService.client().revokeDevice(device.id, reason))
    )
    if (!r.ok) return
    platform.haptic('success')
    onClose()
    onChanged()
  }

  return (
    <>
      <SheetHeader
        icon={<DeviceGlyph platform={device.platform} />}
        feature={tone === 'neutral' ? 'accent' : tone}
        tileClassName={tone === 'neutral' ? NEUTRAL_HEADER_TILE : undefined}
        title={<span className="block truncate">{device.name}</span>}
        subtitle={added ? `${label} · added ${added}` : label}
      />

      {step === 'details' && (
        <>
          <SheetBody>
            <DeviceFacts device={device} now={now} />
            <p id={noteId} className={NOTE}>
              {!canSignOut
                ? PRIMARY_ONLY
                : device.current
                  ? 'If you sign out here, this device deletes its keys. Your other devices are not changed.'
                  : 'After you sign it out, new messages are no longer encrypted for this device.'}
            </p>
          </SheetBody>
          <SheetFoot className="gap-2.5 pt-1">
            <Button variant="quiet" size="mobile" onClick={startRename}>
              <Pencil /> Rename
            </Button>
            <Button
              variant="danger"
              size="mobile"
              disabled={!canSignOut}
              aria-describedby={canSignOut ? undefined : noteId}
              onClick={startSignOut}
            >
              <LogOut /> {device.current ? 'Sign out of this device' : 'Sign out this device'}
            </Button>
          </SheetFoot>
        </>
      )}

      {step === 'rename' && (
        <>
          <SheetBody>
            <form id={formId} onSubmit={(e) => void save(e)}>
              <MobileField
                id={fieldId}
                label="Device name"
                hint="Only you see this name. Other people see the name that the device had when it was linked."
                error={renaming.error}
              >
                <Input
                  ref={nameField}
                  size="touch"
                  value={name}
                  maxLength={64}
                  autoComplete="off"
                  enterKeyHint="done"
                  onChange={(e) => setName(e.target.value)}
                />
              </MobileField>
            </form>
          </SheetBody>
          <SheetFoot className="gap-2.5 pt-1">
            <Button variant="quiet" size="mobile" onClick={() => setStep('details')}>
              Cancel
            </Button>
            <Button
              type="submit"
              form={formId}
              size="mobile"
              disabled={renaming.busy || !name.trim()}
            >
              {renaming.busy ? 'Saving…' : 'Save'}
            </Button>
          </SheetFoot>
        </>
      )}

      {step === 'signOut' && (
        <>
          <SheetBody>
            <RemoveDeviceBody reason={reason} onReasonChange={setReason} touch className={TEXT} />
            {signOut.error && (
              <p role="alert" className={ALERT}>
                {signOut.error}
              </p>
            )}
          </SheetBody>
          <SheetFoot className="gap-2.5 pt-1">
            <Button
              variant="quiet"
              size="mobile"
              disabled={signOut.busy}
              onClick={() => setStep('details')}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              size="mobile"
              disabled={signOut.busy}
              onClick={() => void confirmSignOut()}
            >
              <LogOut /> Sign out the device
            </Button>
          </SheetFoot>
        </>
      )}
    </>
  )
}

/**
 * The static rows of the sheet (M26): when the device was last active and added, and its app. The
 * place, the device that linked it, the app version and the key fingerprint wait for the data
 * (spec section 5).
 */
function DeviceFacts({ device, now }: { device: DeviceSummary; now: number }): React.JSX.Element {
  const lastActive = lastActiveText(device, now)
  const added = addedText(device.createdAt, now)
  return (
    <ListGroup>
      {lastActive && (
        <ListRow icon={<Clock />} tile="neutral" label="Last active" detail={lastActive} />
      )}
      {added && <ListRow icon={<Link />} tile="neutral" label="Added" detail={added} />}
      <ListRow
        icon={<AppWindow />}
        tile="neutral"
        label="App"
        detail={
          device.status === 'pending'
            ? `${PLATFORM_LABEL[device.platform]} · not linked yet`
            : PLATFORM_LABEL[device.platform]
        }
      />
    </ListGroup>
  )
}
