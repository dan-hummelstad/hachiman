import { ArrowUpRight, KeyRound, Link2, Lock, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useSignIn } from '@/hooks/use-sign-in'
import { cn } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'

/**
 * Signed-out screen (A1): the wallpaper with a violet glow, the app mark top-left, and one square
 * card with the single primary action. The set-up paths after sign-in show as chips that only
 * inform. After sign-in, the encryption onboarding (security/onboarding.tsx) sets up this device.
 */
export function SignInScreen(): React.JSX.Element {
  const { signIn, busy, error } = useSignIn()
  const { platform } = usePlatform()

  return (
    <div className="bg-surface-window relative isolate flex min-h-full w-full flex-1 flex-col overflow-y-auto">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(ellipse_60%_55%_at_50%_45%,color-mix(in_srgb,var(--accent-primary)_22%,transparent),transparent)]"
      />
      <div className="flex items-center gap-2.5 px-7 pt-6">
        <AppMark className="size-7 text-[15px]" />
        <span className="text-label">Hachiman</span>
      </div>
      <div className="flex flex-1 items-center justify-center p-4">
        <section
          aria-labelledby="sign-in-title"
          className="border-line-hairline bg-surface-content shadow-soft grid w-full max-w-[440px] gap-5 border p-9"
        >
          <AppMark className="size-[60px] text-[30px] shadow-[0_8px_28px_color-mix(in_srgb,var(--accent-primary)_45%,transparent)]" />
          <div className="grid gap-2">
            <h1 id="sign-in-title" className="text-page-title">
              Sign in to Hachiman
            </h1>
            <p className="text-text-secondary text-[15px] leading-[1.5]">
              Hachiman uses your Takusen account. Sign in to see your guilds, messages and voice
              channels.
            </p>
          </div>
          <div className="grid gap-3">
            <Button size="lg" className="h-11 w-full" disabled={busy} onClick={() => void signIn()}>
              <ArrowUpRight />
              {busy ? 'Opening Takusen…' : 'Sign in with Takusen'}
            </Button>
            <ErrorText>{error}</ErrorText>
            <p className="text-meta text-text-tertiary text-center">
              {platform === 'browser'
                ? 'You’ll sign in on Takusen and come straight back.'
                : 'Your browser opens to finish signing in. Come back here when it says you’re done.'}
            </p>
          </div>
          <div className="border-line-hairline grid gap-3 border-t pt-5">
            <div className="flex items-start gap-3">
              <span
                aria-hidden
                className="bg-feature-voice/15 text-feature-voice-text rounded-control flex size-7 shrink-0 items-center justify-center [&_svg]:size-4"
              >
                <Lock />
              </span>
              <p className="text-[13px] leading-[18px]">
                Messages and calls are end-to-end encrypted. After you sign in, you set up this
                device:
              </p>
            </div>
            <ul aria-label="Ways to set up this device" className="grid grid-cols-3 gap-2">
              <PathChip icon={<Link2 />} tone="text-accent-text">
                Link it
              </PathChip>
              <PathChip icon={<KeyRound />} tone="text-feature-voice-text">
                Restore it
              </PathChip>
              <PathChip icon={<Sparkles />} tone="text-feature-event-text">
                Start new
              </PathChip>
            </ul>
          </div>
        </section>
      </div>
    </div>
  )
}

/** The app mark: 八 (hachi) on the accent gradient. Decorative. */
function AppMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'from-accent-primary to-feature-page text-text-on-accent flex shrink-0 items-center justify-center bg-gradient-to-br leading-none font-bold',
        className
      )}
    >
      八
    </span>
  )
}

/** A set-up path as a quiet chip: information, not a control. */
function PathChip({
  icon,
  tone,
  children
}: {
  icon: React.ReactNode
  tone: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="border-line-hairline rounded-control text-text-primary flex h-8 items-center justify-center gap-1.5 border text-[13px] font-semibold">
      <span aria-hidden className={cn('[&_svg]:size-3.5', tone)}>
        {icon}
      </span>
      {children}
    </li>
  )
}
