import { Fragment } from 'react'
import { KeyRound, Link2, ShieldCheck, Sparkles } from 'lucide-react'
import { useDeviceNoun } from '@/components/security/onboarding-steps'
import { AppMark, EmptyWindow, EntryCard, FOOTER_LINKS } from '@/components/security/screen-window'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { useLayout } from '@/hooks/use-layout'
import { useSignIn } from '@/hooks/use-sign-in'
import { takusenService } from '@/services/TakusenService'
import type { IPlatformService } from '@/shared/IPlatformService'
import { usePlatform } from '@/shared/PlatformContext'

/** How the sign-in comes back to the app, under the button. */
function helperText(platform: IPlatformService['platform']): string {
  return platform === 'electron'
    ? 'Your browser opens to finish signing in. Come back here when it says you’re done.'
    : 'You’ll sign in on Takusen and come straight back.'
}

/**
 * Signed-out screen (Three Questions, A): no colour. The entry backdrop with one square card and
 * the single primary action. The set-up paths after sign-in show as chips that only inform. After
 * sign-in, the encryption onboarding (security/onboarding.tsx) sets up this device. The mobile
 * layout shows `MobileSignIn`.
 */
export function SignInScreen(): React.JSX.Element {
  const { signIn, busy, error } = useSignIn()
  const { platform } = usePlatform()
  const layout = useLayout()

  if (layout === 'mobile') {
    return (
      <MobileSignIn
        onSignIn={() => void signIn()}
        busy={busy}
        error={error}
        helper={helperText(platform)}
      />
    )
  }

  return (
    <EmptyWindow>
      <EntryCard
        titleId="sign-in-title"
        eyebrow="Sign in"
        title="Sign in to Hachiman"
        sub="Hachiman uses your Takusen account. Your spaces, pages and messages travel with it."
        note={
          <>
            <div className="flex gap-2.5">
              <ShieldCheck aria-hidden className="text-text-tertiary mt-0.5 size-[15px] shrink-0" />
              <p className="text-text-tertiary text-[12px] leading-[1.5]">
                Messages and calls are end-to-end encrypted. After you sign in, you set up this
                device:
              </p>
            </div>
            <ul aria-label="Ways to set up this device" className="mt-3 flex gap-1.5 pl-[25px]">
              <PathChip icon={<Link2 />}>Link it</PathChip>
              <PathChip icon={<KeyRound />}>Restore it</PathChip>
              <PathChip icon={<Sparkles />}>Start new</PathChip>
            </ul>
          </>
        }
      >
        <Button
          size="lg"
          className="h-[46px] w-full gap-[9px] text-[14.5px]"
          disabled={busy}
          onClick={() => void signIn()}
        >
          <KeyRound className="size-4" />
          {busy ? 'Opening Takusen…' : 'Continue with Takusen'}
        </Button>
        <ErrorText>{error}</ErrorText>
        <p className="text-text-tertiary mt-3 text-center text-[12px] leading-[1.5]">
          {helperText(platform)}
        </p>
        <LostAccess />
      </EntryCard>
    </EmptyWindow>
  )
}

/** "Lost access?" line: text, not a link. Restore lives in the onboarding after sign-in. */
function LostAccess({ mobile }: { mobile?: boolean }): React.JSX.Element {
  return (
    <p
      className={
        mobile
          ? 'mt-5 flex items-center justify-center gap-1.5'
          : 'mt-[18px] flex items-center justify-center gap-1.5'
      }
    >
      <span
        className={
          mobile
            ? 'text-text-disabled font-mono text-[9px] tracking-[1.1px]'
            : 'text-text-disabled font-mono text-[9.5px] tracking-[1.1px]'
        }
      >
        LOST ACCESS?
      </span>
      <span
        className={
          mobile
            ? 'text-text-secondary text-[13px] font-semibold'
            : 'text-text-secondary text-[12.5px] font-semibold'
        }
      >
        Use your recovery key after you sign in.
      </span>
    </p>
  )
}

/**
 * Mobile sign-in (C4): the content sits on the sheet colour, with no card. The mark, the title
 * and the primary scroll; the encryption note sits at the foot, then the Takusen links. Takusen
 * draws the account screens inside the system sign-in sheet. This screen has no colour: the
 * primary is inked.
 */
function MobileSignIn({
  onSignIn,
  busy,
  error,
  helper
}: {
  onSignIn: () => void
  busy: boolean
  error: string | null
  helper: string
}): React.JSX.Element {
  const origin = takusenService.env.issuerOrigin
  const noun = useDeviceNoun()
  return (
    <div className="bg-surface-content flex h-full w-full flex-col overflow-y-auto pt-(--safe-top) pb-(--safe-bottom)">
      <section aria-labelledby="sign-in-title" className="flex flex-1 flex-col px-[26px] pt-[70px]">
        <AppMark className="size-16 rounded-[20px] text-[32px]" />
        <h1
          id="sign-in-title"
          className="text-text-primary mt-[26px] text-[27px] leading-[1.2] font-semibold tracking-[-0.8px]"
        >
          Sign in to Hachiman
        </h1>
        <p className="text-text-tertiary mt-3 text-[14px] leading-[1.5]">
          Hachiman uses your Takusen account. Your spaces, channels and messages travel with it.
        </p>
        <div className="mt-[34px] grid gap-3">
          <ErrorText>{error}</ErrorText>
          <Button
            size="mobile"
            className="bg-ink text-on-ink hover:bg-ink/90 h-[54px] gap-[9px] text-[15.5px]"
            disabled={busy}
            onClick={onSignIn}
          >
            <KeyRound className="size-[17px]" />
            {busy ? 'Opening Takusen…' : 'Continue with Takusen'}
          </Button>
        </div>
        <p className="text-text-tertiary mt-3 text-center text-[13px]">{helper}</p>
        <LostAccess mobile />
      </section>
      <div className="flex gap-2.5 px-3.5 pt-3.5 pb-5">
        <ShieldCheck aria-hidden className="text-text-tertiary mt-0.5 size-[15px] shrink-0" />
        <p className="text-text-tertiary text-[11.5px] leading-[1.45]">
          Messages and calls are end-to-end encrypted. After you sign in, you link this {noun} to
          one you already use, or restore it with your recovery key.
        </p>
      </div>
      <nav
        aria-label="Takusen"
        className="text-text-disabled flex items-center justify-center gap-1.5 px-6 pb-1.5 font-mono text-[9px] tracking-[1.2px] uppercase"
      >
        {FOOTER_LINKS.map(({ label, hash }, i) => (
          <Fragment key={hash}>
            {i > 0 && <span aria-hidden>·</span>}
            <a
              href={`${origin}/#${hash}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-control active:bg-surface-hover focus-visible:outline-line-focus inline-flex h-11 items-center px-2 outline-none focus-visible:outline-2"
            >
              {label}
            </a>
          </Fragment>
        ))}
      </nav>
    </div>
  )
}

/** A set-up path as a quiet chip: information, not a control. */
function PathChip({
  icon,
  children
}: {
  icon: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="rounded-row border-line-strong text-text-tertiary inline-flex items-center gap-[5px] border px-2 py-1 font-mono text-[9px] tracking-[0.3px]">
      <span aria-hidden className="text-text-disabled [&_svg]:size-[11px]">
        {icon}
      </span>
      {children}
    </li>
  )
}
