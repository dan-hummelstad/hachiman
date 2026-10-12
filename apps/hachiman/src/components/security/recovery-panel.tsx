import { useState } from 'react'
import { Check, KeyRound, TriangleAlert } from 'lucide-react'
import { DockedFoot, MobileFoot } from '@/components/mobile/foot'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Chip } from '@/components/ui/chip'
import { FEATURE_TILE } from '@/components/ui/feature'
import { ErrorText } from '@/components/ui/field'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { friendly } from '@/components/security/errors'
import { RecoveryKeyReveal } from '@/components/security/recovery-key-view'
import { StepFooter, StepFrame, StepHeader } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'
import { openDialog, useDialog } from '@/stores/dialogStore'

/** The desktop dialog step, or the step in a mobile sheet (M27). */
type ViewSize = 'default' | 'touch'

const PRIMARY_ONLY =
  'Only a device with your security key can make a recovery key: your first device, or a device that you restored with the recovery key.'

/** An error on the mobile layout: 13/600 red, as the set-up screens. */
const TOUCH_ERROR = 'text-feature-danger-text text-[13px] leading-[1.4] font-semibold'

/**
 * Make a new recovery key (§12.11.3 "A recovery key rotation"): the Worker uploads all backups
 * again under the new key and deletes the old ones. The old key stops working. The new key lives
 * only in the state of this hook, never in a store. `onShowingKey` hears when it shows and when
 * it goes away.
 */
function useRotateRecoveryKey(onShowingKey?: (showing: boolean) => void): {
  primary: boolean
  configured: boolean
  recoveryKey: string | null
  busy: boolean
  error: string | null
  rotate: () => Promise<void>
  /** Drops the key from the state. */
  clear: () => void
} {
  const platform = usePlatform()
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  const configured = useCryptoStore((s) => s.status?.recoveryConfigured ?? false)
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const { run, busy, error } = useAction()

  const rotate = async (): Promise<void> => {
    const r = await run('make a new recovery key', () =>
      friendly(cryptoService.client().rotateRecoveryKey())
    )
    platform.haptic(r.ok ? 'success' : 'warning')
    if (!r.ok) return
    onShowingKey?.(true)
    setRecoveryKey(r.value.recoveryKey)
  }
  const clear = (): void => {
    setRecoveryKey(null)
    onShowingKey?.(false)
  }
  return { primary, configured, recoveryKey, busy, error, rotate, clear }
}

/**
 * The rotation as a dialog step: what happens, then the new key one time. `size="touch"` is the
 * new key sheet of M27.
 */
export function RotateRecoveryKey({
  onDone,
  onShowingKey,
  size = 'default'
}: {
  onDone?: () => void
  /** True while the new key shows. */
  onShowingKey?: (showing: boolean) => void
  size?: ViewSize
}): React.JSX.Element {
  const { primary, configured, recoveryKey, busy, error, rotate, clear } =
    useRotateRecoveryKey(onShowingKey)
  const touch = size === 'touch'

  if (recoveryKey)
    return (
      <RecoveryKeyReveal
        recoveryKey={recoveryKey}
        doneLabel="Done"
        size={size}
        onDone={() => {
          // In a sheet, the key stays while the sheet slides out: `onDone` closes and unmounts it.
          if (touch && onDone) {
            onShowingKey?.(false)
            return onDone()
          }
          clear()
          onDone?.()
        }}
      />
    )

  const subtitle = configured ? 'Replaces the key you have now' : 'Your account has none yet'
  const footer = (
    <>
      {onDone && (
        <Button variant="quiet" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      )}
      <Button disabled={!primary || busy} onClick={() => void rotate()}>
        <KeyRound /> {busy ? 'Making the key…' : 'Make a new recovery key'}
      </Button>
    </>
  )

  if (touch) {
    return (
      <>
        <StepHeader
          icon={<KeyRound />}
          feature="event"
          title="Make a new recovery key"
          subtitle={subtitle}
        />
        <div className="flex flex-col gap-4">
          {configured && (
            <Callout
              size="touch"
              tone="caution"
              icon={<TriangleAlert />}
              title="Your old key stops working"
            >
              The new key replaces it, and Hachiman encrypts your backups again with the new key.
            </Callout>
          )}
          <p className="text-text-secondary text-[14.5px] leading-[1.5] font-medium">
            You see the new key once. Have somewhere safe and offline ready to keep it.
          </p>
          {!primary && (
            <p className="text-text-tertiary text-[13px] leading-[1.5] font-medium">
              {PRIMARY_ONLY}
            </p>
          )}
          {error && (
            <p role="alert" className={TOUCH_ERROR}>
              {error}
            </p>
          )}
        </div>
        <StepFooter>{footer}</StepFooter>
      </>
    )
  }

  return (
    <StepFrame
      icon={<KeyRound />}
      feature="event"
      title="Make a new recovery key"
      subtitle={subtitle}
      footer={footer}
    >
      <p>
        {configured
          ? 'Your account has a recovery key. With it, you can use your messages on a new device when no other device is signed in.'
          : 'Your account has no recovery key. If you lose all of your devices, you cannot read your messages again.'}
      </p>
      <Callout tone="caution">
        A new recovery key replaces the old one. The old key stops working, and Hachiman encrypts
        your backups again with the new key.
      </Callout>
      {!primary && <p className="text-meta text-text-tertiary">{PRIMARY_ONLY}</p>}
      <ErrorText>{error}</ErrorText>
    </StepFrame>
  )
}

/**
 * Dialog kind 'recoveryKey'. While a new key shows, the window closes only through the "I saved"
 * confirmation: the owner refuses every other close (the old key no longer works then). On the
 * mobile layout it is the M27 sheet: while the key shows it is not dismissible (no drag, scrim or
 * Escape close) and the Sheet Header has no close button.
 */
export function RecoveryKeyDialog(): React.JSX.Element {
  const { open, close } = useDialog('recoveryKey')
  const mobile = useLayout() === 'mobile'
  const [showing, setShowing] = useState(false)
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !showing && close()}>
      <DialogContent
        aria-describedby={undefined}
        className="sm:max-w-[520px]"
        showCloseButton={!(mobile && showing)}
        dismissible={!showing}
      >
        <RotateRecoveryKey
          size={mobile ? 'touch' : 'default'}
          onShowingKey={setShowing}
          onDone={close}
        />
      </DialogContent>
    </Dialog>
  )
}

/**
 * User settings → Recovery key (H3 on the desktop layout, M27 on the mobile layout): the status
 * card, the risk in red, and the one action. The rotation runs in the 'recoveryKey' dialog, which
 * cannot close while the new key shows (the old key no longer works then).
 */
export function RecoverySection(): React.JSX.Element {
  return useLayout() === 'mobile' ? <RecoveryMobile /> : <RecoveryDesktop />
}

const MAKE_NEW_KEY_HINT =
  'Make a new key if you lost the old one, or if someone else could have seen it.'
const PRIMARY_ONLY_SHORT = ' Only a device with your security key can do this.'

function RecoveryDesktop(): React.JSX.Element {
  const configured = useCryptoStore((s) => s.status?.recoveryConfigured ?? false)
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  return (
    <div className="grid gap-4">
      <div
        className={cn(
          'flex items-center gap-4 border px-4 py-4',
          configured
            ? 'border-feature-voice/40 bg-feature-voice/5'
            : 'border-feature-event/40 bg-feature-event/5'
        )}
      >
        <span
          className={cn(
            'flex size-12 shrink-0 items-center justify-center [&_svg]:size-6',
            configured
              ? 'bg-feature-voice/15 text-feature-voice-text'
              : 'bg-feature-event/15 text-feature-event-text'
          )}
        >
          <KeyRound aria-hidden />
        </span>
        <div className="grid min-w-0 flex-1 gap-0.5">
          <p className="text-heading">
            {configured ? 'Your account has a recovery key' : 'Your account has no recovery key'}
          </p>
          <p className="text-text-secondary text-[13px]">
            {configured
              ? 'Keep it somewhere safe and offline.'
              : 'If you lose all of your devices, you cannot read your messages again.'}
          </p>
        </div>
        {configured && (
          <span className="rounded-check bg-feature-voice/15 text-feature-voice-text flex h-6 shrink-0 items-center gap-1 px-2 text-xs font-bold">
            <Check aria-hidden className="size-3.5" /> Set up
          </span>
        )}
      </div>
      <Callout tone="danger">
        Anyone with your recovery key can read all of your encrypted history.
      </Callout>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          size="lg"
          disabled={!primary}
          onClick={() => openDialog({ kind: 'recoveryKey' })}
        >
          <KeyRound /> Make a new recovery key
        </Button>
        <p className="text-meta text-text-tertiary min-w-0 flex-1">
          {MAKE_NEW_KEY_HINT}
          {primary ? '' : PRIMARY_ONLY_SHORT}
        </p>
      </div>
    </div>
  )
}

/**
 * M27 under its sheet: the status card with the chip above the title, the risk once in red, and
 * the helper over a 48 secondary at the foot. The intro paragraph comes from the settings screen.
 * The foot docks under the panel, so it stays in reach when the body scrolls (iPhone SE).
 */
function RecoveryMobile(): React.JSX.Element {
  const configured = useCryptoStore((s) => s.status?.recoveryConfigured ?? false)
  const primary = useCryptoStore((s) => s.status?.primary ?? false)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  return (
    <div ref={setRoot} className="flex flex-col gap-3">
      <div
        className={cn(
          'flex gap-3.5 border p-4',
          configured
            ? 'border-feature-voice/22 bg-feature-voice/5'
            : 'border-feature-event/22 bg-feature-event/5'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex size-11 shrink-0 items-center justify-center [&_svg]:size-[22px]',
            FEATURE_TILE[configured ? 'voice' : 'event']
          )}
        >
          <KeyRound />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          {configured && (
            <Chip tone="voice" icon={<Check />} className="mb-0.5 self-start">
              Set up
            </Chip>
          )}
          <p className="text-text-primary text-[15.5px] leading-[1.3] font-extrabold">
            {configured ? 'Your account has a recovery key' : 'Your account has no recovery key'}
          </p>
          <p className="text-text-secondary text-[13px] leading-[1.45] font-medium">
            {configured
              ? 'Keep it somewhere safe and offline.'
              : 'If you lose all of your devices, you cannot read your messages again.'}
          </p>
        </div>
      </div>
      <Callout size="touch" tone="danger">
        <span className="text-text-primary">
          Anyone with your recovery key can read all of your encrypted history.
        </span>
      </Callout>
      <DockedFoot anchor={root}>
        <MobileFoot className="bg-surface-content -mx-4 gap-3">
          <p className="text-text-tertiary text-[13px] leading-[1.5] font-medium">
            {MAKE_NEW_KEY_HINT}
            {primary ? '' : PRIMARY_ONLY_SHORT}
          </p>
          <Button
            variant="secondary"
            size="mobile"
            disabled={!primary}
            onClick={() => openDialog({ kind: 'recoveryKey' })}
          >
            <KeyRound /> Make a new recovery key
          </Button>
        </MobileFoot>
      </DockedFoot>
    </div>
  )
}
