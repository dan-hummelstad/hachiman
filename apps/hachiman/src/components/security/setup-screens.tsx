import { useId, useState } from 'react'
import {
  Check,
  CircleHelp,
  KeyRound,
  LifeBuoy,
  Link2,
  LogOut,
  OctagonAlert,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  TriangleAlert
} from 'lucide-react'
import type { CryptoState } from '@hachiman/crypto'
import { ListGroup, ListRow, SectionLabel } from '@/components/mobile/list'
import { NavActionButton } from '@/components/mobile/nav-bar'
import { Sheet, SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Checkbox } from '@/components/ui/checkbox'
import type { Feature } from '@/components/ui/feature'
import { RadioCard } from '@/components/ui/radio-card'
import { HostTrustNote } from '@/components/security/host-trust'
import { RecoveryKeyActions, RecoveryKeyBlock } from '@/components/security/recovery-key-view'
import {
  SETUP_PATHS,
  pathDisabled,
  recommendedPath,
  selectedPath,
  useDeviceNoun,
  useStepTitles,
  type AccountFacts,
  type DeviceNoun,
  type OnboardingStep,
  type SetupPath
} from '@/components/security/onboarding-steps'
import { StepFrame } from '@/components/security/screen-window'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useTakusenStore } from '@/stores/takusenStore'

/** One path of M16: its card and the label of the primary button while it is selected. */
interface PathView {
  icon: React.ReactNode
  feature: Feature
  title: string
  description: string
  /** Shown in place of the description while the path cannot work. */
  unavailable: string
  action: string
}

function pathViews(noun: DeviceNoun, facts: AccountFacts | null): Record<SetupPath, PathView> {
  return {
    link: {
      icon: <Link2 />,
      feature: 'accent',
      title: 'Link to a device you use',
      description: 'Your desktop or another phone sends the keys over. All your history comes too.',
      unavailable: 'Not available: the reset signed out all of your other devices.',
      action: `Link this ${noun}`
    },
    restore: {
      icon: <LifeBuoy />,
      feature: 'voice',
      title: 'Restore with recovery key',
      description: 'Type the recovery key that you saved when you set up Hachiman.',
      unavailable: '',
      action: 'Enter recovery key'
    },
    setup: {
      icon: <Sparkles />,
      feature: 'event',
      title: 'Start a new identity',
      description: 'Only if this is your first device. You get a new recovery key.',
      unavailable: facts?.passwordReset
        ? 'Not available after a reset. Use your recovery key, or reset your keys.'
        : `Not available: your account already has a security key. Link this ${noun} or use your recovery key.`,
      action: 'Start new'
    }
  }
}

/**
 * M16: the three paths as a native radio group (link, restore, start new). The selection and the
 * Recommended badge follow the account facts until the user picks. The primary button goes to the
 * selected path. The quiet line under it leads to the reset (after a password reset) or
 * explains the admin reset (when the account has a key). Help explains the paths and has Sign out.
 */
export function ChooseScreen({
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
  const platform = usePlatform()
  const noun = useDeviceNoun()
  const titleOf = useStepTitles()
  const hostTrust = useCryptoStore((s) => s.status?.hostTrust ?? null)
  const [pick, setPick] = useState<SetupPath | null>(null)
  const [sheet, setSheet] = useState<'help' | 'admin' | null>(null)
  const name = useId()
  const selected = selectedPath(pick, facts)
  const recommended = facts === null ? null : recommendedPath(facts)
  const reset = facts?.passwordReset === true
  const existing = facts?.hasMaster === true
  const views = pathViews(noun, facts)
  const handle = useTakusenStore((s) => s.session?.user.handle ?? null)
  const quiet = reset ? () => onStep('reset') : existing ? () => setSheet('admin') : null

  return (
    <StepFrame
      icon={<ShieldCheck />}
      title={titleOf('choose')}
      subtitle={handle ? `Signed in as ${handle}` : 'End-to-end encrypted'}
      action={
        gate && (
          <NavActionButton label="Help" onClick={() => setSheet('help')}>
            <CircleHelp />
          </NavActionButton>
        )
      }
      footer={
        <>
          <Button size="mobile" onClick={() => onStep(selected)}>
            {views[selected].icon}
            {views[selected].action}
          </Button>
          {quiet && (
            <QuietLine onClick={quiet}>
              <RotateCcw aria-hidden className="size-4" />
              Lost all devices and your key? Reset
            </QuietLine>
          )}
        </>
      }
    >
      <p className="text-text-secondary text-[15px] leading-[1.45] font-medium">
        Messages and calls are end-to-end encrypted. Choose how this {noun} gets the keys that read
        them.
      </p>
      {state === 'linking' && (
        <Callout size="touch" tone="info">
          A link to another device started on this {noun} and did not finish. Start again.
        </Callout>
      )}
      {reset && (
        <Callout size="touch" tone="caution" title="Your keys were reset">
          This signed out all of your devices and stopped your security key. Use your recovery key
          to get your key and your message history back.
        </Callout>
      )}
      <fieldset className="m-0 grid min-w-0 gap-2.5 border-0 p-0">
        <legend className="section-label mb-1 px-1 pt-1">Choose one</legend>
        {SETUP_PATHS.map((path) => {
          const view = views[path]
          const disabled = pathDisabled(path, facts)
          return (
            <RadioCard
              key={path}
              size="mobile"
              name={name}
              value={path}
              checked={selected === path}
              disabled={disabled}
              onChange={() => {
                setPick(path)
                platform.haptic('light')
              }}
              icon={view.icon}
              feature={view.feature}
              title={view.title}
              description={disabled ? view.unavailable : view.description}
              badge={recommended === path ? 'Recommended' : undefined}
              className="has-disabled:cursor-default has-disabled:opacity-55"
            />
          )
        })}
      </fieldset>
      {gate && hostTrust === 'server_code' && <HostTrustNote />}
      {gate && (
        <HelpSheet
          open={sheet === 'help'}
          noun={noun}
          onOpenChange={(o) => setSheet(o ? 'help' : null)}
        />
      )}
      <AdminResetSheet
        open={sheet === 'admin'}
        gate={gate}
        onOpenChange={(o) => setSheet(o ? 'admin' : null)}
      />
    </StepFrame>
  )
}

/** A quiet text action under the primary button: 44 tall, centred. */
function QuietLine({
  onClick,
  children
}: {
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-text-tertiary active:text-text-primary focus-visible:outline-line-focus rounded-control inline-flex min-h-11 items-center justify-center gap-2 self-center px-3 text-[14px] leading-[18px] font-semibold underline-offset-4 outline-none hover:underline focus-visible:outline-2"
    >
      {children}
    </button>
  )
}

/** Help on M16: the three paths in words, and Sign out (another account, or start again). */
function HelpSheet({
  open,
  noun,
  onOpenChange
}: {
  open: boolean
  noun: DeviceNoun
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader
          icon={<CircleHelp />}
          title={`Ways to set up this ${noun}`}
          subtitle="Your keys stay on your devices"
        />
        <SheetBody>
          <p className="text-text-secondary text-[15px] leading-[1.45]">
            Hachiman encrypts your messages and calls on your devices. The server cannot read them.
            This {noun} gets your security keys in one of three ways.
          </p>
          <ListGroup>
            <ListRow
              icon={<Link2 />}
              label="Link it"
              detail={`Another device where you use Hachiman sends the keys and your history to this ${noun}.`}
            />
            <ListRow
              icon={<LifeBuoy />}
              tile="voice"
              label="Restore it"
              detail="Type the recovery key that you saved when you set up your first device."
            />
            <ListRow
              icon={<Sparkles />}
              tile="event"
              label="Start new"
              detail="Only for your first device: new security keys and a recovery key to keep."
            />
          </ListGroup>
        </SheetBody>
        <SheetFoot>
          <Button size="mobile" variant="secondary" onClick={() => takusenService.signOut()}>
            <LogOut /> Sign out
          </Button>
        </SheetFoot>
      </SheetContent>
    </Sheet>
  )
}

/** M16, account with a key: what to do with no other device and no recovery key. */
function AdminResetSheet({
  open,
  gate,
  onOpenChange
}: {
  open: boolean
  gate: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetHeader
          icon={<RotateCcw />}
          feature="danger"
          title="No device and no recovery key"
          subtitle="Only the admin can reset your keys"
        />
        <SheetBody>
          <p className="text-text-secondary text-[15px] leading-[1.45]">
            Ask the admin of this server to reset your keys. Then sign in again and select{' '}
            <b className="text-text-primary">Reset my keys</b>. After a reset, you cannot read your
            old messages.
          </p>
        </SheetBody>
        {gate && (
          <SheetFoot>
            <Button size="mobile" variant="secondary" onClick={() => takusenService.signOut()}>
              <LogOut /> Sign out
            </Button>
          </SheetFoot>
        )}
      </SheetContent>
    </Sheet>
  )
}

/** The form of a create step before the key exists. */
export interface CreateForm {
  title: string
  busy: boolean
  error: string | null
  onBack: () => void
  onCreate: () => void
}

/** A create step's error on a phone screen. */
function ScreenError({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  if (!children) return null
  return (
    <p role="alert" className="text-feature-danger-text text-[13px] leading-[1.4] font-semibold">
      {children}
    </p>
  )
}

/**
 * The 44 confirm row of the set-up screens (M19, M20): the kit checkbox and its text, and the
 * whole row is the label. `textId` names the text, for the `aria-describedby` of the button that
 * the tick enables.
 */
function ConfirmRow({
  checked,
  onChange,
  textId,
  children
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  textId?: string
  children: React.ReactNode
}): React.JSX.Element {
  const id = useId()
  return (
    <label
      htmlFor={id}
      className="text-text-primary flex min-h-11 items-center gap-3 px-0.5 py-1 text-[14.5px] leading-[1.4] font-semibold"
    >
      <Checkbox id={id} size="lg" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span id={textId}>{children}</span>
    </label>
  )
}

/**
 * M19, first state: what a new identity gives, and when to link instead. "Make my keys" runs
 * `setupFirstDevice`; then `NewKeyScreen` shows the key.
 */
export function NewIdentityScreen({
  title,
  busy,
  error,
  onBack,
  onCreate,
  onLink
}: CreateForm & { onLink?: () => void }): React.JSX.Element {
  const noun = useDeviceNoun()
  return (
    <StepFrame
      icon={<Sparkles />}
      feature="event"
      title={title}
      subtitle="New keys for your account"
      onBack={busy ? undefined : onBack}
      footer={
        <Button size="mobile" disabled={busy} onClick={onCreate}>
          <KeyRound />
          {busy ? 'Making keys…' : 'Make my keys'}
        </Button>
      }
    >
      <div className="grid gap-[18px]">
        <section className="grid gap-2.5">
          <SectionLabel>What you get</SectionLabel>
          <ListGroup>
            <ListRow
              icon={<KeyRound />}
              label="A security key"
              detail={`Lives only on this ${noun}`}
            />
            <ListRow
              icon={<LifeBuoy />}
              tile="voice"
              label="A recovery key"
              detail="For you to keep safe and offline"
            />
          </ListGroup>
        </section>
        <Callout
          size="touch"
          tone="caution"
          icon={<TriangleAlert />}
          action={onLink && !busy ? { label: 'Link instead', onClick: onLink } : undefined}
        >
          Do this only if Hachiman is on no other device. If it is, link this {noun} to it instead.
        </Callout>
        <ScreenError>{error}</ScreenError>
      </div>
    </StepFrame>
  )
}

/**
 * M19, second state (also after the M20 reset): the new recovery key, one time. There is no Back:
 * the identity exists now. The primary button closes the flow after the tick.
 */
export function NewKeyScreen({
  title,
  recoveryKey,
  onDone
}: {
  title: string
  recoveryKey: string
  onDone: () => void
}): React.JSX.Element {
  const noun = useDeviceNoun()
  const [saved, setSaved] = useState(false)
  return (
    <StepFrame
      icon={<KeyRound />}
      feature="event"
      title={title}
      subtitle="Save your recovery key"
      footer={
        <>
          <ConfirmRow checked={saved} onChange={setSaved}>
            I saved my recovery key somewhere safe.
          </ConfirmRow>
          <Button size="mobile" disabled={!saved} onClick={onDone}>
            <Check />
            Set up this {noun}
          </Button>
        </>
      }
    >
      <div className="grid gap-[18px]">
        <p className="text-text-secondary font-medium">
          Hachiman shows this key only this one time. With it, you can read your messages on a new
          device when no other device is signed in.
        </p>
        <section className="grid gap-2.5">
          <SectionLabel>Your recovery key</SectionLabel>
          <RecoveryKeyBlock recoveryKey={recoveryKey} size="touch" />
          <RecoveryKeyActions recoveryKey={recoveryKey} size="touch" />
        </section>
        <p className="text-feature-danger-text flex items-start gap-2.5 text-[13.5px] leading-[1.45] font-semibold">
          <OctagonAlert aria-hidden className="mt-px size-[17px] shrink-0" />
          Anyone with this key can read all of your messages. Keep it private and offline.
        </p>
      </div>
    </StepFrame>
  )
}

/**
 * M20: reset the keys after a password reset. The consequence is one red callout, the restore
 * path sits above as the way out, and the red button waits for the tick.
 */
export function ResetScreen({
  title,
  busy,
  error,
  onBack,
  onCreate,
  onRestore
}: CreateForm & { onRestore?: () => void }): React.JSX.Element {
  const [understood, setUnderstood] = useState(false)
  const confirmId = useId()
  return (
    <StepFrame
      icon={<RotateCcw />}
      feature="danger"
      title={title}
      subtitle="Start over without your old messages"
      onBack={busy ? undefined : onBack}
      footer={
        <>
          <ConfirmRow checked={understood} onChange={setUnderstood} textId={confirmId}>
            I understand that I cannot read my old messages after the reset.
          </ConfirmRow>
          <Button
            size="mobile"
            variant="danger"
            disabled={busy || !understood}
            aria-describedby={confirmId}
            onClick={onCreate}
          >
            <RotateCcw />
            {busy ? 'Making keys…' : 'Reset my keys'}
          </Button>
        </>
      }
    >
      <div className="grid gap-[22px]">
        <Callout
          size="touch"
          tone="danger"
          icon={<OctagonAlert />}
          title={
            <span className="text-feature-danger-text">Your old messages become unreadable</span>
          }
        >
          A reset makes a new security key. Messages from before the reset cannot be read on any
          device, and your contacts see that your security key changed. Your account and guilds
          stay.
        </Callout>
        {onRestore && (
          <section className="grid gap-2.5">
            <SectionLabel>Have your recovery key?</SectionLabel>
            <ListGroup>
              <ListRow
                icon={<LifeBuoy />}
                tile="voice"
                label="Restore with recovery key"
                detail="Keeps your old messages readable"
                disabled={busy}
                onClick={onRestore}
              />
            </ListGroup>
          </section>
        )}
        <ScreenError>{error}</ScreenError>
      </div>
    </StepFrame>
  )
}
