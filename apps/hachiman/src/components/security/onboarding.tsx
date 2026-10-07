import { useEffect, useId, useState } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { KeyRound, Link2, RotateCcw, Sparkles } from 'lucide-react'
import type { CryptoState } from '@hachiman/crypto'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { friendly } from '@/components/security/errors'
import { HostTrustNote } from '@/components/security/host-trust'
import { LinkAsNewDevice } from '@/components/security/link-new-device'
import { ONBOARDING_TITLES, type OnboardingStep } from '@/components/security/onboarding-steps'
import { RecoveryKeyInput, RecoveryKeyReveal } from '@/components/security/recovery-key-view'
import { ScreenWindow, Warning } from '@/components/security/screen-window'
import { useAction } from '@/hooks/use-action'
import { cn } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { createDsTransport } from '@/services/ds-transport'
import { hachiman } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useTakusenStore } from '@/stores/takusenStore'

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

/**
 * The identity onboarding of this device (§12.4, §12.5, §12.11.3): set up a first device, link
 * from another device, restore with the recovery key, or reset after a password reset.
 *
 * `onHold(true)` keeps the caller from closing the flow while a new recovery key shows: the status
 * turns 'ready' before the user saved the key.
 */
export function OnboardingFlow({
  state,
  step,
  onStep,
  onHold,
  onFinished
}: {
  state: CryptoState
  step: OnboardingStep
  onStep: (step: OnboardingStep) => void
  onHold: (hold: boolean) => void
  /** After the last step (the status is 'ready'). */
  onFinished?: () => void
}): React.JSX.Element {
  const userId = useCryptoStore((s) => s.status?.userId ?? null)
  const facts = useAccountFacts(userId)
  const back = (): void => onStep('choose')

  if (state === 'ready' && step !== 'setup' && step !== 'reset') {
    return (
      <div className="grid gap-3">
        <p className="text-sm">Encryption is set up on this device.</p>
        {onFinished && <Button onClick={onFinished}>Close</Button>}
      </div>
    )
  }

  switch (step) {
    case 'setup':
      return <CreateIdentity mode="setup" onHold={onHold} onBack={back} onFinished={onFinished} />
    case 'reset':
      return <CreateIdentity mode="reset" onHold={onHold} onBack={back} onFinished={onFinished} />
    case 'link':
      return <LinkAsNewDevice onBack={back} />
    case 'restore':
      return <Restore onBack={back} />
    case 'choose':
      return <Choose state={state} facts={facts} onStep={onStep} />
  }
}

function Choose({
  state,
  facts,
  onStep
}: {
  state: CryptoState
  facts: AccountFacts | null
  onStep: (step: OnboardingStep) => void
}): React.JSX.Element {
  const reset = facts?.passwordReset === true
  const existing = facts?.hasMaster === true
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Hachiman encrypts your messages and calls on your devices. The server cannot read them. This
        device needs your security keys before it can show them.
      </p>
      {state === 'linking' && (
        <Warning tone="info">
          A link to another device started on this device and did not finish. Start again.
        </Warning>
      )}
      {reset && (
        <Warning>
          Your password or your security keys were reset. This signed out all of your devices and
          stopped your security key. Use your recovery key to get your key and your message history
          back.
        </Warning>
      )}
      {!reset && (
        <ChoiceButton
          icon={<Link2 />}
          title="Link from another device"
          hint="Use a device where you already use Hachiman. Your history comes too."
          primary={existing}
          onClick={() => onStep('link')}
        />
      )}
      <ChoiceButton
        icon={<KeyRound />}
        title="Restore with recovery key"
        hint="Use the recovery key that you saved when you set up your first device."
        primary={reset}
        onClick={() => onStep('restore')}
      />
      {reset ? (
        <ChoiceButton
          icon={<RotateCcw />}
          title="Reset my keys"
          hint="Only if you lost the recovery key. Old messages become unreadable."
          danger
          onClick={() => onStep('reset')}
        />
      ) : (
        <ChoiceButton
          icon={<Sparkles />}
          title="Set up this device"
          hint={
            existing
              ? 'Not available: your account already has a security key. Link this device or use your recovery key.'
              : 'For your first device. This makes a new security key and a recovery key.'
          }
          primary={facts !== null && !existing}
          disabled={existing}
          onClick={() => onStep('setup')}
        />
      )}
      {existing && (
        <p className="text-muted-foreground text-xs">
          No other device and no recovery key? Ask the admin of this server to reset your keys. Then
          sign in again and select Reset my keys.
        </p>
      )}
    </div>
  )
}

function ChoiceButton(props: {
  icon: React.ReactNode
  title: string
  hint: string
  primary?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={props.disabled}
      onClick={props.onClick}
      className={cn(
        'hover:bg-accent flex items-start gap-3 border p-3 text-left disabled:pointer-events-none disabled:opacity-60',
        'focus-visible:outline-ring outline-none focus-visible:outline-2',
        '[&>svg]:mt-0.5 [&>svg]:size-5 [&>svg]:shrink-0',
        props.primary && 'border-primary',
        props.danger && 'border-destructive/60'
      )}
    >
      {props.icon}
      <span className="grid gap-0.5">
        <span className={cn('text-sm font-semibold', props.danger && 'text-destructive')}>
          {props.title}
        </span>
        <span className="text-muted-foreground text-xs leading-4">{props.hint}</span>
      </span>
    </button>
  )
}

function CreateIdentity({
  mode,
  onHold,
  onBack,
  onFinished
}: {
  mode: 'setup' | 'reset'
  onHold: (hold: boolean) => void
  onBack: () => void
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

  return (
    <div className="grid gap-3">
      {mode === 'setup' ? (
        <p className="text-sm">
          This makes a new security key for your account on this device, and a recovery key for you
          to keep. Do this only if you do not use Hachiman on another device.
        </p>
      ) : (
        <>
          <Warning tone="danger">
            A reset makes a new security key. Messages from before the reset become unreadable, on
            all devices. Your contacts see that your security key changed. If you have your recovery
            key, go back and use it.
          </Warning>
          <label htmlFor={checkId} className="flex items-start gap-2 text-sm">
            <Checkbox
              id={checkId}
              className="mt-0.5"
              checked={understood}
              onChange={(e) => setUnderstood(e.target.checked)}
            />
            I understand that I cannot read my old messages after the reset.
          </label>
        </>
      )}
      <ErrorText>{error}</ErrorText>
      <Button
        variant={mode === 'reset' ? 'destructive' : 'default'}
        disabled={busy || (mode === 'reset' && !understood)}
        onClick={() => void create()}
      >
        {busy ? 'Making keys…' : mode === 'setup' ? 'Set up this device' : 'Reset my keys'}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={onBack}>
        Back
      </Button>
    </div>
  )
}

function Restore({ onBack }: { onBack: () => void }): React.JSX.Element {
  const { run, busy, error } = useAction()
  return (
    <div className="grid gap-3">
      <p className="text-sm">
        Type or paste your recovery key. Hachiman gets your security key and your message history
        from the encrypted backup.
      </p>
      <RecoveryKeyInput
        busy={busy}
        error={error}
        submitLabel="Restore"
        onSubmit={(key) =>
          void run('restore', () => friendly(cryptoService.restoreFromRecoveryKey(key)))
        }
      />
      <Button variant="ghost" disabled={busy} onClick={onBack}>
        Back
      </Button>
    </div>
  )
}

/**
 * The app root for a signed-in user: the shell when the identity of this device is ready, else
 * the start-up, error or onboarding screen (driven by cryptoStore).
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
      <p className="text-sm" role="status">
        Hachiman opens the key store of this device…
      </p>
    </ScreenWindow>
  )
}

function OnboardingScreen({
  state,
  onHold
}: {
  state: CryptoState
  onHold: (hold: boolean) => void
}): React.JSX.Element {
  const [step, setStep] = useState<OnboardingStep>('choose')
  const hostTrust = useCryptoStore((s) => s.status?.hostTrust ?? null)
  return (
    <ScreenWindow title={ONBOARDING_TITLES[step]} wide>
      <OnboardingFlow state={state} step={step} onStep={setStep} onHold={onHold} />
      {hostTrust === 'server_code' && <HostTrustNote />}
      <button
        type="button"
        className="text-muted-foreground justify-self-start text-xs underline-offset-4 hover:underline"
        onClick={() => takusenService.signOut()}
      >
        Sign out
      </button>
    </ScreenWindow>
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => takusenService.signOut()}>
          Sign out
        </Button>
        <Button onClick={retry}>Try again</Button>
      </div>
    </ScreenWindow>
  )
}
