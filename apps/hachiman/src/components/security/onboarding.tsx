import { useEffect, useId, useState } from 'react'
import {
  Check,
  ChevronLeft,
  KeyRound,
  Link2,
  LogOut,
  RotateCcw,
  ShieldCheck,
  Sparkles
} from 'lucide-react'
import type { CryptoState } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ErrorText } from '@/components/ui/field'
import { friendly } from '@/components/security/errors'
import { HostTrustNote } from '@/components/security/host-trust'
import { LinkAsNewDevice } from '@/components/security/link-new-device'
import { ONBOARDING_TITLES, type OnboardingStep } from '@/components/security/onboarding-steps'
import { RecoveryKeyInput, RecoveryKeyReveal } from '@/components/security/recovery-key-view'
import {
  EmptyWindow,
  OptionCard,
  ScreenActions,
  ScreenWindow,
  StepFrame,
  StepHeader
} from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { createDsTransport } from '@/services/ds-transport'
import { hachiman } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { Callout } from '@/components/ui/callout'

/** What the server says about the account, for the choice of steps. Null while it loads or fails. */
interface AccountFacts {
  /** The account has a current master key: set up is not possible, link or restore is. */
  hasMaster: boolean
  /** No current master key and devices revoked by a password reset (§12.4 "Password reset"). */
  passwordReset: boolean
}

function useAccountFacts(userId: string | null): AccountFacts | null {
  const [facts, setFacts] = useState<{ userId: string; value: AccountFacts } | null>(null)
  useEffect(() => {
    if (!userId) return
    let live = true
    Promise.all([hachiman.rest.getUserKeys(userId), hachiman.rest.listDevices()]).then(
      ([keys, devices]) => {
        if (!live) return
        const hasMaster = keys.masterKey !== null
        const passwordReset = !hasMaster && devices.some((d) => d.revokeReason === 'password_reset')
        setFacts({ userId, value: { hasMaster, passwordReset } })
      },
      (e: unknown) => console.warn('[security] account facts failed', e)
    )
    return () => {
      live = false
    }
  }, [userId])
  return facts && facts.userId === userId ? facts.value : null
}

/** The Back button that starts the footer of a step. */
export function BackButton({
  onClick,
  disabled
}: {
  onClick: () => void
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Button variant="quiet" className="sm:mr-auto" disabled={disabled} onClick={onClick}>
      <ChevronLeft /> Back
    </Button>
  )
}

/**
 * The identity onboarding of this device (§12.4, §12.5, §12.11.3): set up a first device, link
 * from another device, restore with the recovery key, or reset after a password reset. Each step
 * renders a whole dialog step (header, body, footer) inside the caller's DialogContent.
 *
 * `onHold(true)` keeps the caller from closing the flow while a new recovery key shows: the status
 * turns 'ready' before the user saved the key.
 */
export function OnboardingFlow({
  state,
  step,
  onStep,
  onHold,
  onFinished,
  gate = false
}: {
  state: CryptoState
  step: OnboardingStep
  onStep: (step: OnboardingStep) => void
  onHold: (hold: boolean) => void
  /** After the last step (the status is 'ready'). */
  onFinished?: () => void
  /** In the CryptoGate (no window behind): the first step offers Sign out and the host note. */
  gate?: boolean
}): React.JSX.Element {
  const userId = useCryptoStore((s) => s.status?.userId ?? null)
  const facts = useAccountFacts(userId)
  const back = (): void => onStep('choose')

  if (state === 'ready' && step !== 'setup' && step !== 'reset') {
    return (
      <StepFrame
        icon={<ShieldCheck />}
        feature="voice"
        title={ONBOARDING_TITLES.choose}
        footer={
          onFinished && (
            <Button className="w-full" onClick={onFinished}>
              Close
            </Button>
          )
        }
      >
        <div className="border-feature-voice/40 bg-feature-voice/5 grid justify-items-center gap-2 border px-4 py-6 text-center">
          <span className="bg-feature-voice/15 text-feature-voice-text flex size-12 items-center justify-center rounded-full [&_svg]:size-6">
            <Check />
          </span>
          <p className="text-heading">Encryption is set up on this device</p>
          <p className="text-text-secondary">
            This device has a security key and can read your messages.
          </p>
        </div>
      </StepFrame>
    )
  }

  switch (step) {
    case 'setup':
      return (
        <CreateIdentity
          mode="setup"
          onHold={onHold}
          onBack={back}
          onLink={() => onStep('link')}
          onFinished={onFinished}
        />
      )
    case 'reset':
      return <CreateIdentity mode="reset" onHold={onHold} onBack={back} onFinished={onFinished} />
    case 'link':
      return <LinkAsNewDevice title={ONBOARDING_TITLES.link} onBack={back} />
    case 'restore':
      return <Restore onBack={back} />
    case 'choose':
      return <Choose state={state} facts={facts} onStep={onStep} gate={gate} />
  }
}

function Choose({
  state,
  facts,
  onStep,
  gate
}: {
  state: CryptoState
  facts: AccountFacts | null
  onStep: (step: OnboardingStep) => void
  gate: boolean
}): React.JSX.Element {
  const reset = facts?.passwordReset === true
  const existing = facts?.hasMaster === true
  const hostTrust = useCryptoStore((s) => s.status?.hostTrust ?? null)
  return (
    <StepFrame
      icon={<ShieldCheck />}
      feature="voice"
      title={ONBOARDING_TITLES.choose}
      subtitle="Your messages and calls are end-to-end encrypted"
      footer={
        gate && (
          <Button variant="quiet" className="sm:mr-auto" onClick={() => takusenService.signOut()}>
            <LogOut /> Sign out
          </Button>
        )
      }
    >
      <p className="text-text-secondary">
        Hachiman encrypts your messages and calls on your devices. The server cannot read them. This
        device needs your security keys before it can show them.
      </p>
      {state === 'linking' && (
        <Callout tone="info">
          A link to another device started on this device and did not finish. Start again.
        </Callout>
      )}
      {reset && (
        <Callout tone="caution">
          Your password or your security keys were reset. This signed out all of your devices and
          stopped your security key. Use your recovery key to get your key and your message history
          back.
        </Callout>
      )}
      {!reset && (
        <OptionCard
          icon={<Link2 />}
          title="Link from another device"
          hint="Use a device where you already use Hachiman. Your history comes too."
          emphasis={existing}
          onClick={() => onStep('link')}
        />
      )}
      <OptionCard
        icon={<KeyRound />}
        feature="voice"
        title="Restore with recovery key"
        hint="Use the recovery key that you saved when you set up your first device."
        emphasis={reset}
        onClick={() => onStep('restore')}
      />
      {reset ? (
        <OptionCard
          icon={<RotateCcw />}
          feature="danger"
          title="Reset my keys"
          hint="Only if you lost the recovery key. Old messages become unreadable."
          onClick={() => onStep('reset')}
        />
      ) : (
        <OptionCard
          icon={<Sparkles />}
          feature="page"
          title="Set up this device"
          hint={
            existing
              ? 'Not available: your account already has a security key. Link this device or use your recovery key.'
              : 'For your first device. This makes a new security key and a recovery key.'
          }
          emphasis={facts !== null && !existing}
          disabled={existing}
          onClick={() => onStep('setup')}
        />
      )}
      {existing && (
        <p className="text-meta text-text-tertiary">
          No other device and no recovery key? Ask the admin of this server to reset your keys. Then
          sign in again and select Reset my keys.
        </p>
      )}
      {gate && hostTrust === 'server_code' && <HostTrustNote />}
    </StepFrame>
  )
}

function CreateIdentity({
  mode,
  onHold,
  onBack,
  onLink,
  onFinished
}: {
  mode: 'setup' | 'reset'
  onHold: (hold: boolean) => void
  onBack: () => void
  onLink?: () => void
  onFinished: (() => void) | undefined
}): React.JSX.Element {
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null)
  const [understood, setUnderstood] = useState(false)
  const { run, busy, error } = useAction()
  const checkId = useId()

  // The key is in this component only: drop the hold when it goes away.
  useEffect(() => () => onHold(false), [onHold])

  const create = async (): Promise<void> => {
    onHold(true)
    const r = await run(mode === 'setup' ? 'set up this device' : 'reset your keys', () =>
      friendly(mode === 'setup' ? cryptoService.setupFirstDevice() : cryptoService.resetIdentity())
    )
    if (r.ok) setRecoveryKey(r.value.recoveryKey)
    else onHold(false)
  }

  if (recoveryKey) {
    return (
      <RecoveryKeyReveal
        recoveryKey={recoveryKey}
        onDone={() => {
          setRecoveryKey(null)
          onHold(false)
          onFinished?.()
        }}
      />
    )
  }

  if (mode === 'setup') {
    return (
      <StepFrame
        icon={<Sparkles />}
        title={ONBOARDING_TITLES.setup}
        subtitle="Start a new identity"
        footer={
          <>
            <BackButton disabled={busy} onClick={onBack} />
            {onLink && (
              <Button variant="secondary" disabled={busy} onClick={onLink}>
                <Link2 /> Link instead
              </Button>
            )}
            <Button disabled={busy} onClick={() => void create()}>
              {busy ? 'Making keys…' : 'Set up this device'}
            </Button>
          </>
        }
      >
        <p>
          This makes a new security key for your account on this device, and a recovery key for you
          to keep.
        </p>
        <ul className="border-line-hairline bg-surface-sunken grid gap-3 border px-3.5 py-3">
          <KeyItem
            icon={<KeyRound />}
            title="A security key"
            hint="Lives only on this device"
            tile="bg-accent-tint text-accent-text"
          />
          <KeyItem
            icon={<RotateCcw />}
            title="A recovery key"
            hint="For you to keep somewhere safe and offline"
            tile="bg-feature-voice/15 text-feature-voice-text"
          />
        </ul>
        <Callout tone="caution">
          Do this only if you do not use Hachiman on another device. If you do, link this device to
          it instead.
        </Callout>
        <ErrorText>{error}</ErrorText>
      </StepFrame>
    )
  }

  return (
    <StepFrame
      icon={<RotateCcw />}
      feature="danger"
      title={ONBOARDING_TITLES.reset}
      subtitle="Start over without your old messages"
      footer={
        <>
          <BackButton disabled={busy} onClick={onBack} />
          <Button variant="danger" disabled={busy || !understood} onClick={() => void create()}>
            <RotateCcw /> {busy ? 'Making keys…' : 'Reset my keys'}
          </Button>
        </>
      }
    >
      <Callout tone="danger">
        A reset makes a new security key. Messages from before the reset become unreadable, on all
        devices. Your contacts see that your security key changed. If you have your recovery key, go
        back and use it.
      </Callout>
      <label htmlFor={checkId} className="flex items-start gap-2">
        <Checkbox
          id={checkId}
          className="mt-0.5"
          checked={understood}
          onChange={(e) => setUnderstood(e.target.checked)}
        />
        I understand that I cannot read my old messages after the reset.
      </label>
      <ErrorText>{error}</ErrorText>
    </StepFrame>
  )
}

function KeyItem(props: {
  icon: React.ReactNode
  title: string
  hint: string
  tile: string
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-3">
      <span
        aria-hidden
        className={cn(
          'rounded-control flex size-8 shrink-0 items-center justify-center [&_svg]:size-4',
          props.tile
        )}
      >
        {props.icon}
      </span>
      <span className="grid">
        <span className="text-label">{props.title}</span>
        <span className="text-meta text-text-tertiary">{props.hint}</span>
      </span>
    </li>
  )
}

function Restore({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <>
      <StepHeader
        icon={<KeyRound />}
        feature="voice"
        title={ONBOARDING_TITLES.restore}
        subtitle="Read your messages on this device"
      />
      <p className="text-sm">
        Type or paste the recovery key that you saved when you set up Hachiman. Hachiman gets your
        security key and your message history from the encrypted backup.
      </p>
      <RecoveryKeyInput
        busy={busy}
        error={error}
        submitLabel="Restore"
        footerStart={<BackButton disabled={busy} onClick={onBack} />}
        onSubmit={(key) =>
          void run('restore', () => friendly(cryptoService.restoreFromRecoveryKey(key)))
        }
      />
    </>
  )
}

/**
 * The app root for a signed-in user: the shell when the identity of this device is ready, else
 * the start-up, error or onboarding screen (driven by cryptoStore). None of them shows over the
 * shell: they show over an empty window (decision 3 of the Arc plan).
 */
export function CryptoGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const phase = useCryptoStore((s) => s.phase)
  const state = useCryptoStore((s) => s.status?.state ?? null)
  const [hold, setHold] = useState(false)

  if (phase === 'ready' && state === 'ready' && !hold) return <>{children}</>
  if (phase === 'error') return <StartError />
  if (hold || (phase === 'ready' && (state === 'needs_identity' || state === 'linking')))
    return <OnboardingScreen state={state ?? 'needs_identity'} onHold={setHold} />
  return (
    <ScreenWindow title="Starting encryption">
      <p className="text-text-secondary text-sm" role="status">
        Hachiman opens the key store of this device…
      </p>
    </ScreenWindow>
  )
}

const keepOpen = (e: Event): void => e.preventDefault()

/** The set-up dialog on the scrim over the empty window. It cannot be dismissed. */
function OnboardingScreen({
  state,
  onHold
}: {
  state: CryptoState
  onHold: (hold: boolean) => void
}): React.JSX.Element {
  const [step, setStep] = useState<OnboardingStep>('choose')
  return (
    <EmptyWindow>
      <Dialog open modal>
        <DialogContent
          showCloseButton={false}
          aria-describedby={undefined}
          onEscapeKeyDown={keepOpen}
          onPointerDownOutside={keepOpen}
          onInteractOutside={keepOpen}
          className="sm:max-w-[560px]"
        >
          <OnboardingFlow state={state} step={step} onStep={setStep} onHold={onHold} gate />
        </DialogContent>
      </Dialog>
    </EmptyWindow>
  )
}

function StartError(): React.JSX.Element {
  const startError = useCryptoStore((s) => s.startError)
  const userId = useTakusenStore((s) => s.session?.user.id ?? null)
  const platform = usePlatform()
  const message = startError?.message ?? ''
  // 'Internal' and every other code: the generic text, with Try again and Sign out.
  const text =
    startError?.code === 'LockHeld'
      ? 'Hachiman is open in another tab or window. Close it there, then select Try again.'
      : startError?.code === 'SecureStorageUnavailable'
        ? 'This device has no safe storage for keys, so Hachiman cannot keep your keys here.'
        : startError?.code === 'StoreCorrupt'
          ? 'The key store of this device is damaged. Sign out, then sign in and link this device again.'
          : `Encryption did not start: ${message || 'unknown error'}.`

  const retry = (): void => {
    if (!userId) return
    void cryptoService.start({
      userId,
      platform,
      transport: createDsTransport(hachiman.rest, hachiman.cache)
    })
  }

  return (
    <ScreenWindow title="Encryption did not start" tone="danger">
      <p className="text-sm">{text}</p>
      <ScreenActions>
        <Button variant="quiet" onClick={() => takusenService.signOut()}>
          Sign out
        </Button>
        <Button onClick={retry}>Try again</Button>
      </ScreenActions>
    </ScreenWindow>
  )
}
