import { useEffect, useId, useRef, useState } from 'react'
import {
  ArrowRight,
  Check,
  ClipboardPaste,
  Link,
  RefreshCw,
  ScanQrCode,
  ShieldCheck,
  Smile,
  TriangleAlert,
  X
} from 'lucide-react'
import { LINK_QR_PREFIX, type SasEmoji } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input, LEAD_PADDING } from '@/components/ui/input'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { MobileField } from '@/components/mobile/field'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import { SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import { Viewfinder } from '@/components/mobile/viewfinder'
import { DeviceGlyph, DeviceTile } from '@/components/security/device-tile'
import { cryptoErrorText } from '@/components/security/errors'
import { FingerprintBox } from '@/components/security/fingerprint-box'
import { Waiting } from '@/components/security/link-new-device'
import { useDeviceNoun } from '@/components/security/onboarding-steps'
import { CameraScan } from '@/components/security/qr-view'
import { SasEmojiRow } from '@/components/security/sas-emoji'
import { useScanOrPaste } from '@/components/security/use-scan-or-paste'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { relativeTime } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'
import { Callout } from '@/components/ui/callout'
import {
  useExistingDeviceLink,
  useLinkSessions,
  type PendingSession,
  type ActiveLink
} from '@/components/security/use-device-link'

/** The sheet takes its full height in every step, so a tab switch does not move its top (M22). */
const FULL_SHEET = 'h-[calc(var(--app-height,100dvh)-var(--safe-top,0px)-8px)]'

/** The selected tab: the raised fill and an accent icon (M22, M23). */
const TAB_SELECTED = 'bg-surface-raised text-text-primary [&_svg]:text-accent-text'

const PHONE_MODES = [
  {
    value: 'qr',
    label: 'Scan the code',
    icon: <ScanQrCode />,
    selectedClassName: TAB_SELECTED
  },
  { value: 'sas', label: 'Compare emoji', icon: <Smile />, selectedClassName: TAB_SELECTED }
] as const

const TEXT = 'text-text-secondary text-sm leading-normal font-medium'
const NOTE = 'text-text-tertiary text-[13px] leading-normal font-medium'
const ALERT = 'text-feature-danger-text text-[13.5px] leading-[18px] font-semibold'

/** What the sheet calls this device: "iPhone" in the iOS app, else "phone" or "device". */
function useThisDevice(): string {
  const noun = useDeviceNoun()
  return usePlatform().platform === 'ios' ? 'iPhone' : noun
}

/**
 * M22 to M24: the caution callout and the method tabs, then the scan tab (camera tile, paste
 * field, "Use this code" at the foot) or the emoji tab (the requests, then the 7 emoji with
 * "They match" at the foot), and at the end the linked device. Close stops an open link. A request
 * from the "A new device asks to link" notice is accepted at once: the keys go only after "They
 * match".
 */
function LinkFromThisPhone({
  initialSessionId,
  onClose
}: {
  initialSessionId: string | null
  onClose: () => void
}): React.JSX.Element {
  const link = useExistingDeviceLink(initialSessionId)
  const { mode, active, sas, done, busy, error } = link
  const here = useThisDevice()
  // The request from the notice, until the first try to accept it.
  const [autoId, setAutoId] = useState(initialSessionId)
  // "They match" went out: the keys go to the new device now.
  const [sent, setSent] = useState(false)

  const restart = (): void => {
    setSent(false)
    link.restart()
  }
  const header = (
    <SheetHeader icon={<Link />} title="Link a new device" subtitle={`From this ${here}`} />
  )
  const alert = error && (
    <p role="alert" className={ALERT}>
      {error}
    </p>
  )

  if (done) {
    return (
      <>
        {header}
        <SheetBody>
          {done.ok && active ? (
            <Linked device={active} here={here} />
          ) : (
            <Outcome tone="danger" icon={<X />} title="The link did not finish">
              {cryptoErrorText({ code: done.error })}
            </Outcome>
          )}
        </SheetBody>
        <SheetFoot className="gap-2.5">
          {!done.ok && (
            <Button variant="quiet" size="mobile" onClick={restart}>
              <RefreshCw /> Try again
            </Button>
          )}
          <Button size="mobile" onClick={onClose}>
            Done
          </Button>
        </SheetFoot>
      </>
    )
  }

  const top = (
    <>
      <Callout
        tone="caution"
        size="touch"
        icon={<TriangleAlert />}
        title="A linked device reads everything"
      >
        Link only a device that you have with you now. It can read all of your messages.
      </Callout>
      <SegmentedControl
        size="touch"
        label="How to link"
        options={PHONE_MODES}
        value={mode}
        onChange={(m) => {
          restart()
          link.setMode(m)
        }}
      />
    </>
  )

  if (active) {
    const compare = sas !== null && !sent
    return (
      <>
        {header}
        <SheetBody>
          {top}
          {compare ? (
            <SasCompare name={active.name} emoji={sas.emoji} />
          ) : (
            <div className="text-sm">
              <Waiting>
                {mode === 'sas' && !sent
                  ? `Waiting for ${active.name}…`
                  : `Sending the keys to ${active.name}…`}
              </Waiting>
            </div>
          )}
        </SheetBody>
        {(compare || alert) && (
          <SheetFoot className="gap-2.5">
            {alert}
            {compare && (
              <>
                <Button
                  variant="quiet"
                  size="mobile"
                  disabled={busy}
                  onClick={() => void link.confirm(false)}
                >
                  <X /> They do not match
                </Button>
                <Button
                  size="mobile"
                  disabled={busy}
                  onClick={() => void link.confirm(true).then((ok) => ok && setSent(true))}
                >
                  <Check /> They match
                </Button>
              </>
            )}
          </SheetFoot>
        )}
      </>
    )
  }

  return (
    <>
      {header}
      {mode === 'qr' ? (
        <ScanTab top={top} busy={busy} alert={alert} onCode={(c) => void link.scan(c)} />
      ) : (
        <RequestsTab
          top={top}
          autoId={autoId}
          busy={busy}
          alert={alert}
          onPick={(s) => {
            setAutoId(null)
            void link.accept(s)
          }}
        />
      )}
    </>
  )
}

/**
 * M22: the camera tile (where the host can scan), the steps, and the paste field with "Use this
 * code" at the foot. A scan error shows under the tile, a paste error under the field.
 */
function ScanTab({
  top,
  busy,
  alert,
  onCode
}: {
  top: React.ReactNode
  busy: boolean
  alert: React.ReactNode
  onCode: (code: string) => void
}): React.JSX.Element {
  const formId = useId()
  const fieldId = useId()
  const scan = useScanOrPaste({
    prefix: LINK_QR_PREFIX,
    onCode,
    wrongScan: 'This is not the right kind of code. Scan the code on the new device.'
  })
  // The hook has one error line: the last action says where it shows.
  const [errorAt, setErrorAt] = useState<'scan' | 'paste'>('scan')
  const scanError = errorAt === 'scan' ? scan.error : null

  const onTile = (): void => {
    setErrorAt('scan')
    if (scan.camera) scan.stopCamera()
    else scan.scan()
  }

  return (
    <>
      <SheetBody>
        {top}
        {scan.canScan && (
          <Viewfinder
            state={scan.camera ? 'live' : scanError ? 'error' : 'idle'}
            disabled={busy}
            onActivate={onTile}
          >
            {scan.camera && (
              <CameraScan
                prefix={LINK_QR_PREFIX}
                onCode={scan.onCameraCode}
                onError={scan.onCameraError}
              />
            )}
          </Viewfinder>
        )}
        {scanError && (
          <p role="alert" className={ALERT}>
            {scanError}
          </p>
        )}
        <p className={TEXT}>
          {scan.canScan ? (
            <>
              On the new device, select <b>Link from another device</b>. Then tap the camera above
              and point it at the code that the new device shows.
            </>
          ) : (
            <>
              On the new device, select <b>Link from another device</b>. Copy the text of the code
              that it shows, and paste it here.
            </>
          )}
        </p>
        <form
          id={formId}
          onSubmit={(e) => {
            setErrorAt('paste')
            scan.submit(e)
          }}
        >
          <MobileField
            id={fieldId}
            label={scan.canScan ? 'Or paste the code text' : 'The code text'}
            error={errorAt === 'paste' ? scan.error : undefined}
          >
            <PasteInput value={scan.text} onChange={scan.setText} />
          </MobileField>
        </form>
      </SheetBody>
      <SheetFoot>
        {alert}
        <Button type="submit" form={formId} size="mobile" disabled={busy || !scan.pasted}>
          <ArrowRight /> Use this code
        </Button>
      </SheetFoot>
    </>
  )
}

/**
 * The one-line mono field of the code text. Its clipboard icon pastes the clipboard (where the
 * page can read it: on iOS the system asks first), for a code copied on a Mac with a shared
 * clipboard. A long press in the field pastes too.
 */
function PasteInput({
  value,
  onChange
}: {
  value: string
  onChange: (text: string) => void
}): React.JSX.Element {
  const canRead = typeof navigator.clipboard?.readText === 'function'
  const paste = (): void => {
    // A refusal (the user closed the system's Paste bubble) changes nothing.
    navigator.clipboard.readText().then(
      (text) => onChange(text.trim()),
      () => undefined
    )
  }
  return (
    <span className="relative flex w-full min-w-0">
      <Input
        size="touch"
        lead={canRead ? undefined : <ClipboardPaste />}
        className={cn('font-mono', canRead && LEAD_PADDING.touch)}
        placeholder={`${LINK_QR_PREFIX}…`}
        value={value}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="go"
        onChange={(e) => onChange(e.target.value)}
      />
      {canRead && (
        <button
          type="button"
          aria-label="Paste from the clipboard"
          onClick={paste}
          className="text-text-tertiary active:text-text-primary focus-visible:outline-line-focus rounded-control absolute inset-y-0 left-0 flex w-11 items-center justify-center pl-px outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
        >
          <ClipboardPaste aria-hidden className="size-[17px]" />
        </button>
      )}
    </span>
  )
}

/**
 * The emoji tab before a request is open: the requests as List Rows (a tap accepts), and "Look
 * again" at the foot. `autoId` (the request from the notice) is accepted as soon as it is in the
 * list.
 */
function RequestsTab({
  top,
  autoId,
  busy,
  alert,
  onPick
}: {
  top: React.ReactNode
  autoId: string | null
  busy: boolean
  alert: React.ReactNode
  onPick: (s: PendingSession) => void
}): React.JSX.Element {
  const { sessions, error, reload } = useLinkSessions()
  const auto = sessions?.find((s) => s.sessionId === autoId) ?? null
  const picked = useRef(false)
  useEffect(() => {
    if (!auto || picked.current) return
    picked.current = true
    onPick(auto)
  }, [auto, onPick])

  return (
    <>
      <SheetBody>
        {top}
        <p className={TEXT}>
          On the new device, select <b>Link from another device</b> and then <b>Compare emoji</b>.
          Then select the device here.
        </p>
        {autoId && sessions && !auto && (
          <p className={NOTE}>
            The request from the notice is not open now. Start the link again on the new device.
          </p>
        )}
        {sessions === null && !error && (
          <p role="status" className={NOTE}>
            Looking for devices…
          </p>
        )}
        {sessions?.length === 0 && (
          <p className={NOTE}>
            No device asks to link now. Start the link on the new device, then tap <b>Look again</b>
            .
          </p>
        )}
        {sessions && sessions.length > 0 && (
          <div className="flex flex-col gap-2">
            <SectionLabel className="px-0">Asking to link · {sessions.length}</SectionLabel>
            <ListGroup role="list">
              {sessions.map((s) => (
                <div key={s.sessionId} role="listitem" className="flex flex-col">
                  <ListRow
                    icon={<DeviceGlyph platform={s.platform} />}
                    tile={s.platform === 'browser' ? 'event' : 'neutral'}
                    label={s.newDeviceName}
                    detail={`${PLATFORM_LABEL[s.platform]} · asked ${relativeTime(s.createdAt)}`}
                    disabled={busy}
                    onClick={() => onPick(s)}
                  />
                </div>
              ))}
            </ListGroup>
          </div>
        )}
      </SheetBody>
      <SheetFoot>
        {alert}
        {error && (
          <p role="alert" className={ALERT}>
            {error}
          </p>
        )}
        <Button variant="secondary" size="mobile" disabled={busy} onClick={reload}>
          <RefreshCw /> Look again
        </Button>
      </SheetFoot>
    </>
  )
}

/** M23: the 7 emoji of the open request, with the steps above and the warning under them. */
function SasCompare({ name, emoji }: { name: string; emoji: SasEmoji[] }): React.JSX.Element {
  return (
    <>
      <p className={TEXT}>
        <b>{name}</b> asks to link. Check that it shows the same emoji, in the same order.
      </p>
      <SasEmojiRow emoji={emoji} size="touch" />
      <p className={NOTE}>
        If an emoji is different, someone can be between the two devices. Tap{' '}
        <b>They do not match</b>, and nothing is linked.
      </p>
    </>
  )
}

/** The result block of the last step: a 64 tile, the title 22/800 and a line, centred. */
function Outcome({
  tone,
  icon,
  title,
  children
}: {
  tone: 'voice' | 'danger'
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className="flex flex-col items-center gap-3 px-2 pt-5 pb-1 text-center"
    >
      <span
        aria-hidden
        className={cn(
          'flex size-16 items-center justify-center border [&_svg]:size-8',
          tone === 'voice'
            ? 'bg-feature-voice/14 border-feature-voice/30 text-feature-voice-text'
            : 'bg-feature-danger/14 border-feature-danger/30 text-feature-danger-text'
        )}
      >
        {icon}
      </span>
      <p className="text-text-primary text-[22px] leading-7 font-extrabold tracking-[-0.2px]">
        {title}
      </p>
      <p className="text-text-secondary text-[14.5px] leading-normal font-medium">{children}</p>
    </div>
  )
}

/**
 * M24: the success block, the new device's card and the key log line. The card shows the key
 * fingerprint only when the API gives one (`FingerprintBox`, none yet).
 */
function Linked({ device, here }: { device: ActiveLink; here: string }): React.JSX.Element {
  const meta = device.platform
    ? `${PLATFORM_LABEL[device.platform]} · linked just now`
    : 'Linked just now'
  return (
    <>
      <Outcome tone="voice" icon={<Check />} title={`${device.name} is linked`}>
        It can read your messages from now on. You can sign it out at any time in Devices.
      </Outcome>
      <div className="border-line-hairline divide-line-hairline flex flex-col divide-y border bg-white/2">
        <div className="flex items-center gap-3 py-3 pr-3.5 pl-3">
          <DeviceTile platform={device.platform} />
          <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
            <span className="text-text-primary truncate text-[15px] leading-[18px] font-extrabold">
              {device.name}
            </span>
            <span className="text-text-tertiary text-[12.5px] leading-[15px] font-medium">
              {meta}
            </span>
          </span>
          <Chip tone="voice" icon={<Check aria-hidden />}>
            Linked
          </Chip>
        </div>
        {/* The API gives no per-device fingerprint yet (spec section 5): nothing renders here
            until `DeviceSummary` or the link result carries one. */}
        <FingerprintBox
          fingerprint={null}
          className="p-3.5"
          hint={`${device.name} shows the same fingerprint under Settings › Devices.`}
        />
      </div>
      <p className="border-feature-voice/22 bg-feature-voice/5 text-text-primary flex items-center gap-3 border px-3.5 py-3 text-[13.5px] leading-[1.45] font-medium">
        <ShieldCheck aria-hidden className="text-feature-voice-text size-[18px] shrink-0" />
        Signed by this {here} and added to your public key log.
      </p>
    </>
  )
}

/** The existing device's side of the link on the mobile layout: the M22 to M24 sheet. */
export function DeviceLinkSheet({
  initialSessionId,
  onClose
}: {
  initialSessionId: string | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <SheetContent className={FULL_SHEET}>
      <LinkFromThisPhone initialSessionId={initialSessionId} onClose={onClose} />
    </SheetContent>
  )
}
