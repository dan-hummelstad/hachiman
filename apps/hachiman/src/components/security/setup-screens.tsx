import { useId, useState } from 'react'
import { CircleHelp, LifeBuoy, Link2, LogOut, RotateCcw, ShieldCheck, Sparkles } from 'lucide-react'
import type { CryptoState } from '@hachiman/crypto'
import { ListGroup, ListRow } from '@/components/mobile/list'
import { NavActionButton } from '@/components/mobile/nav-bar'
import { Sheet, SheetBody, SheetContent, SheetFoot, SheetHeader } from '@/components/mobile/sheet'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import type { Feature } from '@/components/ui/feature'
import { RadioCard } from '@/components/ui/radio-card'
import { HostTrustNote } from '@/components/security/host-trust'
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
