import { useEffect } from 'react'
import { ArrowRight, Check, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ONBOARDING_TITLES,
  useDeviceNoun,
  useStepTitles,
  type DeviceNoun
} from '@/components/security/onboarding-steps'
import { StepFrame } from '@/components/security/screen-window'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'
import { useTakusenStore } from '@/stores/takusenStore'

/**
 * The success card of a finished set-up: the desktop window's last step, and M21 on a phone
 * (`size="touch"`).
 */
function SetupDoneCard({
  noun,
  size = 'default'
}: {
  noun: DeviceNoun
  size?: 'default' | 'touch'
}): React.JSX.Element {
  const touch = size === 'touch'
  return (
    <div
      className={cn(
        'border-feature-voice/40 bg-feature-voice/5 grid justify-items-center gap-2 border px-4 py-6 text-center',
        touch && 'border-feature-voice/20 gap-3 px-5 pt-[30px] pb-7'
      )}
    >
      <span
        className={cn(
          'bg-feature-voice/15 text-feature-voice-text flex size-12 items-center justify-center rounded-full [&_svg]:size-6',
          touch && 'size-16 [&_svg]:size-8'
        )}
      >
        <Check />
      </span>
      <p className={touch ? 'text-[19px] leading-6 font-extrabold' : 'text-heading'}>
        Encryption is set up on this {noun}
      </p>
      <p className={cn('text-text-secondary', touch && 'text-[14.5px] font-medium')}>
        This {noun} has a security key and can read your messages.
      </p>
    </div>
  )
}

/** The desktop window's last step, "Encryption is set up". `onDone` (Close) shows only when set. */
export function SetupDoneStep({ onDone }: { onDone?: () => void }): React.JSX.Element {
  const noun = useDeviceNoun()
  return (
    <StepFrame
      icon={<ShieldCheck />}
      feature="voice"
      title={ONBOARDING_TITLES.choose}
      footer={
        onDone && (
          <Button className="w-full" onClick={onDone}>
            Close
          </Button>
        )
      }
    >
      <SetupDoneCard noun={noun} />
    </StepFrame>
  )
}

/**
 * M21, the set-up is done on a phone. `onDone` ("Open Hachiman") closes the flow, and shows only
 * when set. `celebrate` taps the success haptic at mount.
 */
export function SetupDoneScreen({
  onDone,
  celebrate = false
}: {
  onDone?: () => void
  celebrate?: boolean
}): React.JSX.Element {
  const platform = usePlatform()
  const noun = useDeviceNoun()
  const titleOf = useStepTitles()
  const handle = useTakusenStore((s) => s.session?.user.handle ?? null)
  useEffect(() => {
    if (celebrate) platform.haptic('success')
  }, [celebrate, platform])

  return (
    <StepFrame
      icon={<ShieldCheck />}
      feature="voice"
      title={titleOf('choose')}
      subtitle={handle ? `Signed in as ${handle}` : 'End-to-end encrypted'}
      footer={
        onDone && (
          <Button size="mobile" onClick={onDone}>
            <ArrowRight />
            Open Hachiman
          </Button>
        )
      }
    >
      <div className="my-auto grid gap-3.5 pb-10">
        <SetupDoneCard noun={noun} size="touch" />
        <p className="text-text-tertiary text-center text-[13px] font-medium">
          You can see this {noun} any time in User settings → Devices.
        </p>
      </div>
    </StepFrame>
  )
}
