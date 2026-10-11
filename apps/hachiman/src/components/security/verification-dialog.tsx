import { Fragment, useEffect, useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import {
  BadgeCheck,
  Camera,
  CameraOff,
  Check,
  ChevronRight,
  ClipboardPaste,
  MonitorSmartphone,
  QrCode,
  ScanLine,
  ShieldAlert,
  ShieldCheck
} from 'lucide-react'
import {
  VERIFY_QR_PREFIX,
  type ContactDevice,
  type SafetyNumber,
  type TrustInfo
} from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { Textarea } from '@/components/ui/textarea'
import { MobileField } from '@/components/mobile/field'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { friendly } from '@/components/security/errors'
import { TrustChip } from '@/components/people/trust-chip'
import { useContactSecurity } from '@/components/people/use-contact-security'
import { invalidateTrust } from '@/components/people/use-contact-trust'
import { PlatformIcon } from '@/components/security/devices-panel'
import { CameraScan, QrCodeView, ScanOrPaste } from '@/components/security/qr-view'
import { useScanOrPaste } from '@/components/security/use-scan-or-paste'
import { useUserName } from '@/components/security/use-user-name'
import {
  contactDevicePlatform,
  safetyRows,
  verificationFoot,
  type FootAction
} from '@/components/security/verification-model'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { formatShortDate } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { usePlatform } from '@/shared/PlatformContext'
import { dismissKeyChange } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'
import { Callout } from '@/components/ui/callout'

const TRUST_TEXT: Record<TrustInfo['state'], string> = {
  verified: 'You verified this person.',
  tofu: 'Not verified. Hachiman uses the security key that it saw first for this person.',
  changed: 'The security key of this person changed. Verify them again.',
  unknown: 'Hachiman has no security key for this person yet.'
}

const PASTE_CAUTION =
  'Paste only a code that you took from their device yourself. A code that came through a message or an email proves nothing.'

/** The state and actions of one verification, for the desktop window and the phone sheet. */
interface Verification {
  name: string
  trust: TrustInfo | null
  safety: SafetyNumber | null
  devices: ContactDevice[] | null
  loadError: string | null
  /** The scan or paste step shows. */
  scanning: boolean
  /** Show the scan step; clears the last scan result. */
  startScan: () => void
  cancelScan: () => void
  /** Clear the last scan result (a scan with the native scanner, which needs no scan step). */
  clearResult: () => void
  scanResult: 'match' | 'mismatch' | null
  showCode: boolean
  setShowCode: (show: boolean) => void
  busy: boolean
  error: string | null
  setVerified: (verified: boolean) => Promise<void>
  acknowledge: () => Promise<void>
  /** Check a scanned or pasted code of theirs. */
  onScan: (payload: string) => Promise<void>
}

/**
 * The state and actions of the dialog. A haptic tap marks the result on iOS: success when the
 * user marks the contact verified or a scan matches, a warning when a scan does not match.
 */
function useVerification(userId: string): Verification {
  const platform = usePlatform()
  const name = useUserName(userId)
  const { trust, safety, devices, error: loadError } = useContactSecurity(userId)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<'match' | 'mismatch' | null>(null)
  const [showCode, setShowCode] = useState(false)
  const { run, busy, error } = useAction()

  const setVerified = async (verified: boolean): Promise<void> => {
    const r = await run(verified ? 'mark as verified' : 'remove the verification', () =>
      friendly(cryptoService.client().setVerified(userId, verified))
    )
    if (!r.ok) return
    if (verified) {
      dismissKeyChange(userId)
      platform.haptic('success')
    }
    invalidateTrust()
  }
  const acknowledge = async (): Promise<void> => {
    const r = await run('accept the new key', () =>
      friendly(cryptoService.client().acknowledgeKeyChange(userId))
    )
    if (!r.ok) return
    dismissKeyChange(userId)
    invalidateTrust()
  }
  const onScan = async (payload: string): Promise<void> => {
    setScanning(false)
    const r = await run('check the code', () => friendly(cryptoService.client().verifyQr(payload)))
    if (!r.ok) return
    const match = r.value.match && r.value.userId === userId
    setScanResult(match ? 'match' : 'mismatch')
    platform.haptic(match ? 'success' : 'warning')
    if (match) {
      dismissKeyChange(userId)
      invalidateTrust()
    }
  }

  return {
    name,
    trust,
    safety,
    devices,
    loadError,
    scanning,
    startScan: () => {
      setScanResult(null)
      setScanning(true)
    },
    cancelScan: () => setScanning(false),
    clearResult: () => setScanResult(null),
    scanResult,
    showCode,
    setShowCode,
    busy,
    error,
    setVerified,
    acknowledge,
    onScan
  }
}

/**
 * Dialog kind 'verification' (§12.5): the safety number of me and one contact, as 12 groups of 5
 * digits and as a QR code. Verify by a scan of their code, or by comparing the digits and then
 * "Mark as verified". Users verify accounts, not devices. The device list shows the names from
 * the device certificates, only for devices whose certificate chain the Worker checked (§12.4).
 * On the mobile layout it is the M9 sheet.
 */
export function VerificationDialog(): React.JSX.Element {
  const { dialog, open, close } = useDialog('verification')
  const v = useVerification(dialog.userId)
  const mobile = useLayout() === 'mobile'
  return mobile ? (
    <VerificationSheet v={v} open={open} close={close} />
  ) : (
    <VerificationWindow v={v} open={open} close={close} />
  )
}

interface ViewProps {
  v: Verification
  open: boolean
  close: () => void
}

function VerificationWindow({ v, open, close }: ViewProps): React.JSX.Element {
  const { name, trust, safety, devices, busy, error } = v
  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={`Verify ${name}`}
      description={`Safety number for you and ${name}`}
      icon={<ShieldCheck />}
      feature="voice"
      className="sm:max-w-[560px]"
      actions={
        <Button variant="secondary" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="-mx-[22px] grid max-h-[70vh] gap-4 overflow-y-auto px-[22px]">
        {v.loadError && <ErrorText>{v.loadError}</ErrorText>}
        {trust && trust.state !== 'tofu' && (
          <p className="flex items-start gap-2 text-sm">
            {trust.state === 'verified' ? (
              <BadgeCheck className="text-feature-voice-text mt-0.5 size-4 shrink-0" />
            ) : trust.state === 'changed' ? (
              <ShieldAlert className="text-feature-danger-text mt-0.5 size-4 shrink-0" />
            ) : null}
            {TRUST_TEXT[trust.state]}
          </p>
        )}
        {trust?.state === 'changed' && (
          <Callout tone="danger">
            A new key can mean that {name} set up their account again. It can also mean that someone
            tries to read your messages. Compare the safety number with {name} in person or on a
            call before you trust it.
          </Callout>
        )}

        {safety && (
          <section className="grid gap-3">
            <p className="text-text-secondary text-sm">
              You and {name} see the same 60 digits. Compare them in person or on a call. If they
              match, nobody is between you.
            </p>
            <div
              aria-label="Safety number"
              className="border-line-hairline bg-surface-sunken grid grid-cols-4 gap-x-6 gap-y-2 border px-5 py-4 font-mono text-[20px] leading-7 font-semibold tracking-[0.08em]"
            >
              {safety.groups.map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </div>
          </section>
        )}

        <section className="grid gap-2">
          {v.scanning ? (
            <>
              <ScanOrPaste
                prefix={VERIFY_QR_PREFIX}
                busy={busy}
                pasteLabel="Or paste the code text from their device"
                onCode={(c) => void v.onScan(c)}
              />
              <Callout tone="caution">{PASTE_CAUTION}</Callout>
              <Button variant="quiet" onClick={v.cancelScan}>
                Cancel
              </Button>
            </>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="lg" disabled={busy} onClick={v.startScan}>
                <ScanLine /> Scan their code
              </Button>
              {trust?.state === 'verified' ? (
                <Button
                  variant="quiet"
                  size="lg"
                  disabled={busy}
                  onClick={() => void v.setVerified(false)}
                >
                  Remove verification
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={busy || !safety}
                  onClick={() => void v.setVerified(true)}
                >
                  <Check /> The numbers match — mark as verified
                </Button>
              )}
              {trust?.state === 'changed' && (
                <Button variant="quiet" disabled={busy} onClick={() => void v.acknowledge()}>
                  Accept the new key without a check
                </Button>
              )}
            </div>
          )}
          {v.scanResult === 'match' && (
            <p className="text-feature-voice-text text-sm font-semibold" role="status">
              The code matches. {name} is verified.
            </p>
          )}
          {v.scanResult === 'mismatch' && (
            <ErrorText>
              The code does not match. Do not mark {name} as verified. Ask them to show their code
              again.
            </ErrorText>
          )}
          <ErrorText>{error}</ErrorText>
          {safety?.qrPayload &&
            (v.showCode ? (
              <div className="grid justify-items-center gap-1 pt-1">
                <QrCodeView value={safety.qrPayload} label={`Safety number code for ${name}`} />
                <span className="text-meta text-text-tertiary">
                  {name} can scan this code on their device.
                </span>
              </div>
            ) : (
              <Button
                variant="quiet"
                size="sm"
                className="justify-self-start"
                onClick={() => v.setShowCode(true)}
              >
                <QrCode /> Show my code for {name} to scan
              </Button>
            ))}
        </section>

        <section className="grid gap-2">
          <SectionHeading className="mb-0">
            Their devices{devices && devices.length > 0 ? ` · ${devices.length}` : ''}
          </SectionHeading>
          {devices === null ? (
            <p className="text-text-tertiary text-sm">Loading…</p>
          ) : devices.length === 0 ? (
            <p className="text-text-tertiary text-sm">No verified devices.</p>
          ) : (
            <ul className="border-line-hairline bg-surface-sunken grid border text-sm">
              {devices.map((d) => (
                <li
                  key={d.deviceId}
                  className="border-line-hairline flex items-center gap-3 border-b px-3.5 py-2.5 last:border-b-0"
                >
                  <MonitorSmartphone className="text-text-secondary size-[18px] shrink-0" />
                  <span className="grid min-w-0 flex-1">
                    <span className="text-label truncate">{d.displayName}</span>
                    <span className="text-meta text-text-tertiary">
                      added {new Date(d.issuedAtMs).toLocaleDateString()}
                    </span>
                  </span>
                  {trust && <TrustChip state={trust.state} />}
                </li>
              ))}
            </ul>
          )}
          <p className="text-meta text-text-tertiary">
            Device names come from the device certificates. A device you don’t expect can mean a
            problem: ask {name}.
          </p>
        </section>
      </div>
    </ModalWindow>
  )
}

/** A line of the sheet's foot or scan step: the result of a scan, or an error. */
const NOTE = 'text-[13.5px] leading-[18px] font-semibold'

/**
 * M9 (docs/ios-mobile-ui-spec.md B1): the sheet from the trust button. Intro, the 60 digits, their
 * devices, the note, then "Show your code instead", which opens the QR code in place. The actions
 * stay at the foot while the body scrolls, the primary one at the bottom (`verificationFoot`).
 * "Scan their code" opens the native scanner (iOS) or a scan step in the body: the camera view
 * where BarcodeDetector exists, and the paste field behind "Paste the code text instead".
 */
function VerificationSheet({ v, open, close }: ViewProps): React.JSX.Element {
  const { name, trust, safety, devices, busy } = v
  const [paste, setPaste] = useState(false)
  const pasteField = useRef<HTMLTextAreaElement>(null)
  const step = useRef<HTMLElement>(null)
  const qrId = useId()
  const scan = useScanOrPaste({ prefix: VERIFY_QR_PREFIX, onCode: (c) => void v.onScan(c) })
  // A native scan that failed (no camera, a code of the wrong kind) shows its error in the step.
  const stepOpen = v.scanning || scan.error !== null

  useEffect(() => {
    if (stepOpen) step.current?.scrollIntoView({ block: 'nearest' })
  }, [stepOpen])

  /** Show the paste field and focus it in the tap, so iOS raises the keyboard (spec §2.8). */
  const openPaste = (): void => {
    flushSync(() => {
      v.startScan()
      setPaste(true)
    })
    pasteField.current?.focus()
  }
  const startScan = (): void => {
    if (scan.native) {
      v.clearResult()
      scan.scan()
      return
    }
    scan.reset()
    if (!scan.canScan) return openPaste()
    setPaste(false)
    v.startScan()
    scan.scan()
  }
  const cancelScan = (): void => {
    scan.reset()
    setPaste(false)
    v.cancelScan()
  }

  const FOOT: Record<FootAction, React.ReactNode> = {
    acceptKey: (
      <Button variant="quiet" size="mobile" disabled={busy} onClick={() => void v.acknowledge()}>
        Accept the new key without a check
      </Button>
    ),
    removeVerification: (
      <Button
        variant="quiet"
        size="mobile"
        disabled={busy}
        onClick={() => void v.setVerified(false)}
      >
        Remove verification
      </Button>
    ),
    scan: (
      <Button variant="secondary" size="mobile" disabled={busy} onClick={startScan}>
        {scan.canScan ? <ScanLine /> : <ClipboardPaste />}
        {scan.canScan ? 'Scan their code' : 'Paste their code'}
      </Button>
    ),
    cancelScan: (
      <Button variant="secondary" size="mobile" onClick={cancelScan}>
        Cancel
      </Button>
    ),
    markVerified: (
      <Button
        size="mobile"
        className="leading-5 whitespace-normal"
        disabled={busy || !safety}
        onClick={() => void v.setVerified(true)}
      >
        <Check /> The numbers match — mark as verified
      </Button>
    )
  }

  return (
    <ModalWindow
      open={open}
      onClose={close}
      title={`Verify ${name}`}
      description={`Safety number for you and ${name}`}
      icon={<ShieldCheck />}
      feature="voice"
      actions={
        <>
          {v.scanResult === 'match' && (
            <p role="status" className={cn(NOTE, 'text-feature-voice-text')}>
              The code matches. {name} is verified.
            </p>
          )}
          {v.scanResult === 'mismatch' && (
            <p role="alert" className={cn(NOTE, 'text-feature-danger-text')}>
              The code does not match. Do not mark {name} as verified. Ask them to show their code
              again.
            </p>
          )}
          {v.error && (
            <p role="alert" className={cn(NOTE, 'text-feature-danger-text')}>
              {v.error}
            </p>
          )}
          {verificationFoot(trust?.state ?? null, stepOpen).map((a) => (
            <Fragment key={a}>{FOOT[a]}</Fragment>
          ))}
        </>
      }
    >
      {v.loadError && (
        <p role="alert" className={cn(NOTE, 'text-feature-danger-text')}>
          {v.loadError}
        </p>
      )}
      {trust && trust.state !== 'tofu' && (
        <p className="text-text-primary flex items-start gap-2 text-[15px] leading-[1.45] font-semibold">
          {trust.state === 'verified' ? (
            <BadgeCheck
              aria-hidden
              className="text-feature-voice-text mt-0.5 size-[18px] shrink-0"
            />
          ) : trust.state === 'changed' ? (
            <ShieldAlert
              aria-hidden
              className="text-feature-danger-text mt-0.5 size-[18px] shrink-0"
            />
          ) : null}
          {TRUST_TEXT[trust.state]}
        </p>
      )}
      {trust?.state === 'changed' && (
        <Callout tone="danger" size="touch">
          A new key can mean that {name} set up their account again. It can also mean that someone
          tries to read your messages. Compare the safety number with {name} in person or on a call
          before you trust it.
        </Callout>
      )}

      {safety && (
        <>
          <p className="text-text-secondary text-[15px] leading-normal font-medium">
            You and {name} see the same 60 digits. Compare them in person or on a call. If they
            match, nobody is between you.
          </p>
          <div
            role="group"
            aria-label="Safety number"
            className="border-line-hairline bg-surface-sunken text-text-primary flex flex-col gap-y-2.5 border px-[18px] py-4 font-mono text-[21px] leading-[26px] font-medium"
          >
            {safetyRows(safety.groups).map((row) => (
              <div key={row.label} className="flex justify-between">
                <span className="sr-only">{row.label}</span>
                {row.groups.map((g, i) => (
                  <span key={i} aria-hidden>
                    {g}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </>
      )}

      <SectionLabel className="px-0">
        Their devices{devices && devices.length > 0 ? ` · ${devices.length}` : ''}
      </SectionLabel>
      {devices === null ? (
        <p className="text-text-tertiary text-[13px] leading-4 font-medium">Loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-text-tertiary text-[13px] leading-4 font-medium">No verified devices.</p>
      ) : (
        <ListGroup role="list">
          {devices.map((d) => {
            const platform = contactDevicePlatform(d.displayName)
            return (
              <div
                key={d.deviceId}
                role="listitem"
                className="flex min-h-[54px] items-center gap-3 px-3.5 py-3"
              >
                {platform ? (
                  <PlatformIcon
                    platform={platform}
                    className="text-text-secondary size-5 shrink-0"
                  />
                ) : (
                  <MonitorSmartphone aria-hidden className="text-text-secondary size-5 shrink-0" />
                )}
                <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
                  <span className="text-text-primary truncate text-[15px] leading-[18px] font-bold">
                    {d.displayName}
                  </span>
                  <span className="text-text-tertiary text-xs leading-[15px] font-medium">
                    added {formatShortDate(d.issuedAtMs)}
                  </span>
                </span>
                {trust && (
                  <TrustChip
                    state={trust.state}
                    className="px-[7px] font-extrabold [&_svg]:size-3"
                  />
                )}
              </div>
            )
          })}
        </ListGroup>
      )}
      <p className="text-text-tertiary text-[13px] leading-normal font-medium">
        Device names come from the device certificates. A device you don’t expect can mean a
        problem: ask {name}.
      </p>

      {safety?.qrPayload && (
        <div className="rounded-option border-line-hairline flex flex-col border bg-white/3">
          <button
            type="button"
            aria-expanded={v.showCode}
            aria-controls={qrId}
            onClick={() => v.setShowCode(!v.showCode)}
            className="rounded-option focus-visible:outline-line-focus active:bg-surface-hover flex min-h-[72px] items-center gap-3.5 py-2.5 pr-3.5 pl-2.5 text-left outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
          >
            <span
              aria-hidden
              className="flex size-[52px] shrink-0 items-center justify-center bg-white text-black"
            >
              <QrCode className="size-10" />
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-text-primary text-[15px] leading-[18px] font-bold">
                Show your code instead
              </span>
              <span className="text-text-tertiary text-[13px] leading-4 font-medium">
                {name} scans it with their device
              </span>
            </span>
            <ChevronRight
              aria-hidden
              className={cn(
                'text-text-tertiary size-[18px] shrink-0 transition-transform motion-reduce:transition-none',
                v.showCode && 'rotate-90'
              )}
            />
          </button>
          {v.showCode && (
            <div id={qrId} className="flex justify-center px-3.5 pt-1 pb-4">
              <QrCodeView value={safety.qrPayload} label={`Safety number code for ${name}`} />
            </div>
          )}
        </div>
      )}

      {stepOpen && (
        <section
          ref={step}
          aria-label={`Check the code of ${name}`}
          className="flex flex-col gap-3"
        >
          {scan.camera && (
            <div className="flex justify-center">
              <CameraScan
                prefix={VERIFY_QR_PREFIX}
                onCode={scan.onCameraCode}
                onError={scan.onCameraError}
              />
            </div>
          )}
          {scan.canScan && (
            <Button
              variant="secondary"
              size="mobile"
              disabled={busy}
              onClick={scan.camera ? scan.stopCamera : scan.scan}
            >
              {scan.camera ? <CameraOff /> : <Camera />}
              {scan.camera ? 'Stop the camera' : 'Scan with the camera'}
            </Button>
          )}
          {paste ? (
            <form onSubmit={scan.submit} className="flex flex-col gap-3">
              <MobileField id="verify-paste" label="The code text from their device">
                <Textarea
                  ref={pasteField}
                  size="touch"
                  className="font-mono break-all"
                  placeholder={`${VERIFY_QR_PREFIX}…`}
                  value={scan.text}
                  spellCheck={false}
                  autoComplete="off"
                  autoCapitalize="off"
                  autoCorrect="off"
                  onChange={(e) => scan.setText(e.target.value)}
                />
              </MobileField>
              <Callout tone="caution" size="touch">
                {PASTE_CAUTION}
              </Callout>
              <Button type="submit" size="mobile" disabled={busy || !scan.pasted}>
                Use this code
              </Button>
            </form>
          ) : (
            <Button variant="quiet" size="mobile" onClick={openPaste}>
              <ClipboardPaste /> Paste the code text instead
            </Button>
          )}
          {scan.error && (
            <p role="alert" className={cn(NOTE, 'text-feature-danger-text')}>
              {scan.error}
            </p>
          )}
        </section>
      )}
    </ModalWindow>
  )
}
