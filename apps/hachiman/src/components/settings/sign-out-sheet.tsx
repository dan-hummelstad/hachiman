import { useState } from 'react'
import { KeyRound, LogOut, MonitorSmartphone, TriangleAlert } from 'lucide-react'
import { ListGroup, ListRow } from '@/components/mobile/list'
import { SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import { useOwnDevices } from '@/components/security/devices-panel'
import { friendly } from '@/components/security/errors'
import { useDeviceNoun } from '@/components/security/onboarding-steps'
import {
  joinNames,
  needsAck,
  otherDeviceNames,
  signOutCase,
  type SignOutCase
} from '@/components/settings/sign-out-model'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog } from '@/components/ui/dialog'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { PLATFORM_LABEL } from '@/lib/device-platform'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useDialog } from '@/stores/dialogStore'
import { openSettings } from '@/stores/navStore'

/**
 * Sign out of this device, from the red row of the mobile settings list (dialog kind `signOut`).
 * On the mobile layout the M35 sheet: the sign-out removes the keys of this device, and the sheet
 * says what brings the history back. With no ready Worker there are no keys to remove, so the
 * sheet only ends the session. A desktop-wide window keeps the plain confirm, which also ends only
 * the session. The automatic sign-outs (an expired session, a revoked device) never come here.
 */
export function SignOutSheet(): React.JSX.Element {
  const { open, close } = useDialog('signOut')
  const mobile = useLayout() === 'mobile'
  if (!mobile) {
    return (
      <ConfirmDialog
        open={open}
        onClose={close}
        title="Sign out?"
        tone="danger"
        icon={<LogOut />}
        confirmLabel="Sign out"
        body="To use Hachiman on this device again, you must sign in again."
        onConfirm={async () => takusenService.signOut()}
      />
    )
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <SignOutContent onClose={close} />
    </Dialog>
  )
}

/** The red wash at the top of the sheet and its red top edge (M35). */
const DANGER_SHEET = 'from-feature-danger/12 bg-linear-to-b to-transparent to-45%'
const DANGER_EDGE = {
  borderTopColor: 'color-mix(in oklab, var(--feature-danger) 50%, transparent)'
} as const

const TEXT = 'text-text-secondary text-[15px] leading-[23px] font-medium'

function SignOutContent({ onClose }: { onClose: () => void }): React.JSX.Element {
  const platform = usePlatform()
  const noun = useDeviceNoun()
  // Keys to remove: the Worker is up and this device has its identity.
  const keys = useCryptoStore((s) => s.phase === 'ready' && s.status?.state === 'ready')
  const recovery = useCryptoStore((s) => s.status?.recoveryConfigured === true)
  const { devices, error: listError } = useOwnDevices(keys)
  const { run, busy, error } = useAction()
  const [ack, setAck] = useState(false)

  const current = devices?.find((d) => d.current)?.name ?? PLATFORM_LABEL[platform.platform]
  const others = devices ? otherDeviceNames(devices) : null
  const c = signOutCase(recovery, others, listError !== null)
  const blocked = busy || (keys && (c === 'loading' || (needsAck(c) && !ack)))

  const signOut = async (): Promise<void> => {
    platform.haptic('warning')
    if (!keys) {
      takusenService.signOut()
      onClose()
      return
    }
    // A failure (offline) keeps the session and the keys: the Worker revokes before it deletes.
    const r = await run('sign out', () => friendly(cryptoService.signOutDevice()))
    if (r.ok) onClose()
  }
  const toRecoveryKey = (): void => {
    onClose()
    openSettings({ kind: 'user' }, 'recovery')
  }

  return (
    <SheetContent className={DANGER_SHEET} style={DANGER_EDGE}>
      <SheetHeader
        icon={<LogOut />}
        feature="danger"
        title={`Sign out of this ${noun}?`}
        subtitle={current}
      />
      <SheetBody>
        {keys ? (
          <>
            <p className={TEXT}>
              Signing out removes this {noun}’s keys. Without them, the messages on this {noun}{' '}
              can’t be read.
            </p>
            <ListGroup>
              <ListRow
                icon={<KeyRound />}
                tile="danger"
                label={`Keys on this ${noun} are deleted`}
                detail="Its copy of your history goes with them"
              />
              <ListRow
                icon={<MonitorSmartphone />}
                tile="neutral"
                {...otherDevicesRow(others, listError)}
              />
            </ListGroup>
            <BackCallout
              case={c}
              noun={noun}
              ack={ack}
              onAck={setAck}
              onRecoveryKey={toRecoveryKey}
            />
          </>
        ) : (
          <p className={TEXT}>To use Hachiman on this {noun} again, you sign in again.</p>
        )}
      </SheetBody>
      <SheetFoot className="gap-2">
        {error && (
          <p
            role="alert"
            className="text-feature-danger-text pb-1 text-[13.5px] leading-[18px] font-semibold"
          >
            {error.replace(/\.$/, '')}. This {noun} is still signed in and keeps its keys.
          </p>
        )}
        <Button variant="danger" size="mobile" disabled={blocked} onClick={() => void signOut()}>
          <LogOut />
          {keys ? 'Sign out and remove keys' : 'Sign out'}
        </Button>
        <Button variant="quiet" size="mobile" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </SheetFoot>
    </SheetContent>
  )
}

/** The second row of M35: the other devices that keep working, or why none shows. */
function otherDevicesRow(
  others: string[] | null,
  listError: string | null
): { label: string; detail: string } {
  if (others === null)
    return listError === null
      ? { label: 'Your other devices keep working', detail: 'Checking your devices…' }
      : { label: 'Your other devices could not load', detail: listError }
  return others.length > 0
    ? { label: 'Your other devices keep working', detail: joinNames(others) }
    : { label: 'No other device has your keys', detail: 'This is your only signed-in device' }
}

/** The look and words of the callout of each case. */
const CALLOUT: Record<
  Exclude<SignOutCase, 'loading'>,
  { box: string; icon: string; title: string; ack?: string }
> = {
  recovery: {
    box: 'border-feature-event/25 bg-feature-event/6',
    icon: 'text-feature-event-text',
    title: 'Your recovery key brings them back',
    ack: 'I know where my recovery key is'
  },
  devices: {
    box: 'border-accent-primary/40 bg-accent-tint',
    icon: 'text-accent-text',
    title: 'Your other devices bring them back'
  },
  lost: {
    box: 'border-feature-danger/40 bg-feature-danger/10',
    icon: 'text-feature-danger-text',
    title: 'Nothing brings them back',
    ack: 'I understand that my history is lost'
  },
  unknown: {
    box: 'border-feature-danger/40 bg-feature-danger/10',
    icon: 'text-feature-danger-text',
    title: 'You have no recovery key',
    ack: 'I understand that my history can be lost'
  }
}

/** The body of the callout of each case. */
function calloutBody(c: Exclude<SignOutCase, 'loading'>, noun: string): string {
  switch (c) {
    case 'recovery':
      return 'Sign in again and enter it to read your history here.'
    case 'devices':
      return `Sign in again and link this ${noun} from one of them.`
    case 'lost':
      return 'You have no recovery key and no other device with your keys. After you sign out, no device can read your history.'
    case 'unknown':
      return 'If no other device has your keys, no device can read your history after you sign out.'
  }
}

/**
 * What brings the history back (M35): the recovery key (gold, a box to tick), another device
 * (accent), or nothing (red, a box to tick; also when the device list did not load). "Recovery key" pushes the recovery key screen (M27),
 * where the user can look at the key or make one.
 */
function BackCallout({
  case: c,
  noun,
  ack,
  onAck,
  onRecoveryKey
}: {
  case: SignOutCase
  noun: string
  ack: boolean
  onAck: (ack: boolean) => void
  onRecoveryKey: () => void
}): React.JSX.Element | null {
  if (c === 'loading') return null
  const look = CALLOUT[c]
  const body = calloutBody(c, noun)
  return (
    <div
      role="note"
      className={cn(
        'flex flex-col gap-1.5 border px-3.5 pt-3.5',
        look.box,
        look.ack ? 'pb-1.5' : 'pb-3.5'
      )}
    >
      <div className="flex gap-3">
        {c === 'lost' || c === 'unknown' ? (
          <TriangleAlert aria-hidden className={cn('size-5 shrink-0', look.icon)} />
        ) : c === 'devices' ? (
          <MonitorSmartphone aria-hidden className={cn('size-5 shrink-0', look.icon)} />
        ) : (
          <KeyRound aria-hidden className={cn('size-5 shrink-0', look.icon)} />
        )}
        <div className="flex min-w-0 flex-col gap-[3px]">
          <p className="text-text-primary text-[15px] leading-[18px] font-bold">{look.title}</p>
          <p className="text-text-secondary text-[12.5px] leading-[18px] font-medium">{body}</p>
        </div>
      </div>
      {look.ack && (
        <div className="flex items-center gap-2.5">
          <label className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-1">
            <Checkbox size="lg" checked={ack} onChange={(e) => onAck(e.target.checked)} />
            <span className="text-text-primary text-sm leading-[18px] font-semibold">
              {look.ack}
            </span>
          </label>
          <button
            type="button"
            onClick={onRecoveryKey}
            className={cn(
              'focus-visible:outline-line-focus -mr-1 flex h-11 shrink-0 items-center px-1 text-[13.5px] font-bold outline-none focus-visible:outline-2',
              look.icon
            )}
          >
            Recovery key
          </button>
        </div>
      )}
    </div>
  )
}
