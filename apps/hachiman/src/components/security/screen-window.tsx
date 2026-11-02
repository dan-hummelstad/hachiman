import { Fragment, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react'
import { MobileFoot } from '@/components/mobile/foot'
import { NavBar } from '@/components/mobile/nav-bar'
import { DialogFooter, DialogTitle } from '@/components/ui/dialog'
import type { Feature } from '@/components/ui/feature'
import { StepScreenContext, useStepLayout } from '@/components/security/onboarding-steps'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import { takusenService } from '@/services/TakusenService'

/** Takusen's landing page sections, in the footer of the entry backdrop. */
export const FOOTER_LINKS = [
  { label: 'Help', hash: 'help' },
  { label: 'Privacy', hash: 'privacy' },
  { label: 'Status', hash: 'status' }
] as const

/** Neutral icon tile: entry and system screens carry no hue. */
export const NEUTRAL_TILE = 'border border-line-strong text-text-secondary bg-transparent'

/** The app mark: 八 (hachi) in inked ground. Decorative. Size comes from the caller. */
export function AppMark({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-ink text-on-ink flex shrink-0 items-center justify-center leading-none font-semibold',
        className
      )}
    >
      八
    </span>
  )
}

/**
 * Three small squares that pulse: something is running right now (`live`). `quiet` is the grey
 * form for a wait that no one is working on yet (mobile "waiting").
 */
export function LiveDots({ tone = 'live' }: { tone?: 'live' | 'quiet' }): React.JSX.Element {
  const fill = tone === 'live' ? 'bg-live' : 'bg-text-tertiary'
  return (
    <span aria-hidden className="inline-flex gap-[3px]">
      <span className={cn('size-1 rounded-[1px] motion-safe:animate-pulse', fill)} />
      <span
        className={cn(
          'size-1 rounded-[1px] opacity-55 motion-safe:animate-pulse [animation-delay:150ms]',
          fill
        )}
      />
      <span
        className={cn(
          'size-1 rounded-[1px] opacity-30 motion-safe:animate-pulse [animation-delay:300ms]',
          fill
        )}
      />
    </span>
  )
}

/**
 * The entry backdrop (Three Questions, 01 Entry): the window colour, a faint 八 behind, the mark
 * and wordmark top-left, an optional aside top-right and the Takusen links at the foot. The
 * screens before the shell (sign-in, encryption start-up, set-up, fatal stops) sit on it, never
 * over decrypted content.
 */
export function EmptyWindow({
  children,
  aside
}: {
  children?: React.ReactNode
  aside?: React.ReactNode
}): React.JSX.Element {
  const origin = takusenService.env.issuerOrigin
  return (
    <div className="bg-surface-window relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden">
      <span
        aria-hidden
        className="pointer-events-none absolute top-[30%] left-1/2 -z-10 -translate-x-1/2 text-[820px] leading-none font-semibold text-[color-mix(in_oklab,var(--text-primary)_4%,var(--surface-window))] select-none"
      >
        八
      </span>
      <div className="flex h-[84px] shrink-0 items-center gap-3 px-10">
        <AppMark className="size-[26px] rounded-[7px] text-[14px]" />
        <span className="text-text-primary text-[16px] font-semibold tracking-[-0.3px]">
          Hachiman
        </span>
        <span className="flex-1" />
        {aside}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4">
        {children}
      </div>
      <nav
        aria-label="Takusen"
        className="text-text-disabled flex h-10 shrink-0 items-center justify-center gap-2 font-mono text-[9px] tracking-[1.2px] uppercase"
      >
        {FOOTER_LINKS.map(({ label, hash }, i) => (
          <Fragment key={hash}>
            {i > 0 && <span aria-hidden>·</span>}
            <a
              href={`${origin}/#${hash}`}
              target="_blank"
              rel="noreferrer"
              className="hover:text-text-secondary"
            >
              {label}
            </a>
          </Fragment>
        ))}
      </nav>
    </div>
  )
}

/**
 * The card of an entry screen: square, hairline, no shadow. The eyebrow, the title and the sub
 * line sit on top; `note` is a sunken strip at the foot.
 */
export function EntryCard({
  eyebrow,
  title,
  sub,
  children,
  note,
  wide,
  titleId
}: {
  eyebrow: string
  title: string
  sub?: string
  children?: React.ReactNode
  note?: React.ReactNode
  wide?: boolean
  titleId?: string
}): React.JSX.Element {
  return (
    <section
      aria-labelledby={titleId}
      className={cn(
        'border-line-hairline bg-surface-content my-auto w-full border',
        wide ? 'max-w-[560px]' : 'max-w-[440px]'
      )}
    >
      <div className="px-[34px] pt-[34px] pb-7">
        <p className="text-text-disabled font-mono text-[9.5px] tracking-[1.6px] uppercase">
          {eyebrow}
        </p>
        <h1
          id={titleId}
          className="text-text-primary mt-3 text-[27px] leading-[1.2] font-semibold tracking-[-0.8px]"
        >
          {title}
        </h1>
        {sub && <p className="text-text-tertiary mt-2.5 text-[14px] leading-[1.55]">{sub}</p>}
        {children && <div className="mt-6 grid">{children}</div>}
      </div>
      {note && (
        <div className="border-line-hairline bg-surface-sunken border-t px-[34px] pt-[18px] pb-[22px]">
          {note}
        </div>
      )}
    </section>
  )
}

/**
 * The mobile frame of the screens before the shell (Template · Pushed screen, kit n3TQN, as a
 * root screen): the safe top and the 52 Nav Bar on the home-tinted window, then a square panel
 * (content colour, top hairline) that scrolls. The steps inside render in the 'screen' layout:
 * `StepHeader` puts its Nav Bar on top, and `StepFooter` docks at the foot of the panel, over the
 * home indicator or on the keyboard.
 */
export function StepScreen({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [nav, setNav] = useState<HTMLDivElement | null>(null)
  const value = useMemo(() => ({ nav }), [nav])
  return (
    <div
      data-slot="step-screen"
      className="bg-surface-panel flex min-h-0 w-full flex-1 flex-col pt-(--safe-top,0px)"
    >
      <div ref={setNav} className="shrink-0" />
      <div className="bg-surface-content text-text-tertiary [&_strong]:text-text-primary flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-[22px] pt-6 pb-[calc(16px+var(--safe-bottom,0px))] text-[14px] leading-[1.5] in-data-[keyboard=open]:pb-4 has-[[data-slot=mobile-foot]]:pb-0">
        <StepScreenContext.Provider value={value}>{children}</StepScreenContext.Provider>
      </div>
    </div>
  )
}

/**
 * A screen before the shell: one dialog card on the scrim over the empty window. The start-up and
 * the fatal screens use it. It is not a Radix dialog: there is nothing behind it to return to.
 * The mobile layout shows it as a `StepScreen` with the title in the Nav Bar.
 */
export function ScreenWindow({
  title,
  children,
  wide,
  tone = 'default'
}: {
  title: string
  children: React.ReactNode
  wide?: boolean
  tone?: 'default' | 'danger'
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  if (mobile) {
    return (
      <StepScreen>
        <StepHeader
          icon={tone === 'danger' ? <ShieldAlert /> : <ShieldCheck />}
          feature={tone === 'danger' ? 'danger' : 'event'}
          title={title}
        />
        {children}
      </StepScreen>
    )
  }
  return (
    <EmptyWindow>
      <section
        aria-labelledby="screen-window-title"
        className={cn(
          'bg-surface-content text-text-primary border-line-hairline my-auto grid w-full gap-4 border px-[34px] pt-[30px] pb-6',
          wide ? 'max-w-[560px]' : 'max-w-[440px]'
        )}
      >
        <header className="grid gap-2.5">
          <p
            className={cn(
              'font-mono text-[9.5px] tracking-[1.6px] uppercase',
              tone === 'danger' ? 'text-you-text' : 'text-text-disabled'
            )}
          >
            {tone === 'danger' ? 'Stopped' : 'Encryption'}
          </p>
          <h1
            id="screen-window-title"
            className="text-[22px] leading-[1.2] font-semibold tracking-[-0.6px]"
          >
            {title}
          </h1>
        </header>
        {children}
      </section>
    </EmptyWindow>
  )
}

/** The footer strip of a ScreenWindow: a hairline on top, the actions on the right. */
export function ScreenActions({ children }: { children: React.ReactNode }): React.JSX.Element {
  if (useStepLayout() === 'screen') return <StepFooter>{children}</StepFooter>
  return (
    <div className="border-line-hairline -mx-[34px] -mb-6 mt-2 flex justify-end gap-2.5 border-t px-[34px] py-4">
      {children}
    </div>
  )
}

/**
 * The Arc dialog header of one step: icon tile, title and an optional subtitle. In the 'screen'
 * layout it is the Nav Bar of the `StepScreen` instead: the title (with the subtitle under it),
 * Back when `onBack` is set, and `action` on the right. The icon does not show there.
 */
export function StepHeader({
  title,
  subtitle,
  onBack,
  action,
  focusKey
}: {
  /** Kept for the callers; the entry design draws no icon tile. */
  icon?: React.ReactNode
  feature?: Feature
  title: string
  subtitle?: string
  /** 'screen' layout: the Nav Bar Back. In a dialog the step has its own Back in the footer. */
  onBack?: () => void
  /** 'screen' layout: the Nav Bar action (`NavActionButton`). */
  action?: React.ReactNode
  /**
   * 'screen' layout: a new value is a new state of the step under the same title (the title takes
   * the focus again, so VoiceOver reads it).
   */
  focusKey?: string
}): React.JSX.Element | null {
  const screen = useContext(StepScreenContext)
  if (screen) {
    return (
      <StepNavBar
        nav={screen.nav}
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        action={action}
        focusKey={focusKey}
      />
    )
  }
  return (
    <header className="grid gap-2.5 pt-1">
      {subtitle && (
        <p className="text-text-disabled font-mono text-[9.5px] tracking-[1.5px] uppercase">
          {subtitle}
        </p>
      )}
      <DialogTitle className="text-text-primary text-[22px] leading-[1.2] font-semibold tracking-[-0.6px]">
        {title}
      </DialogTitle>
    </header>
  )
}

/**
 * The Nav Bar of a step on the frame's top. Its title takes the focus when it or `focusKey`
 * changes, so VoiceOver reads the new step.
 */
function StepNavBar({
  nav,
  title,
  subtitle,
  onBack,
  action,
  focusKey
}: {
  nav: HTMLElement | null
  title: string
  subtitle?: string
  onBack?: () => void
  action?: React.ReactNode
  focusKey?: string
}): React.JSX.Element | null {
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (nav) titleRef.current?.focus({ preventScroll: true })
  }, [nav, title, focusKey])
  if (!nav) return null
  return createPortal(
    <NavBar
      title={title}
      subtitle={subtitle}
      onBack={onBack}
      action={action}
      titleRef={titleRef}
    />,
    nav
  )
}

/** The scrolling body of one step. In the 'screen' layout the panel scrolls, not the body. */
export function StepBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  if (useStepLayout() === 'screen') {
    return <div className="flex flex-1 flex-col gap-3">{children}</div>
  }
  return (
    <div className="text-text-tertiary [&_strong]:text-text-primary -mx-[28px] grid max-h-[65vh] gap-3.5 overflow-y-auto px-[28px] text-[13px] leading-[1.55]">
      {children}
    </div>
  )
}

/**
 * The footer strip of one step. Put a Back or Sign out first, with `mr-auto`. In the 'screen'
 * layout it is the docked foot: the buttons stack at 48 and full width, so put the primary last.
 */
export function StepFooter({ children }: { children: React.ReactNode }): React.JSX.Element {
  if (useStepLayout() === 'screen') {
    return (
      <MobileFoot className="bg-surface-content border-line-hairline sticky bottom-0 z-10 -mx-[22px] mt-auto border-t [&>[data-slot=button]]:h-12 [&>[data-slot=button]]:w-full [&>[data-slot=button]]:text-[15px] [&>[data-slot=button]]:font-semibold">
        {children}
      </MobileFoot>
    )
  }
  return <DialogFooter className="gap-2.5 sm:items-center">{children}</DialogFooter>
}

/**
 * One step of a security dialog (header, body, footer). It renders inside a DialogContent, or in
 * a `StepScreen` on the mobile set-up gate (see `StepHeader` for `onBack` and `action`).
 */
export function StepFrame({
  icon,
  feature,
  title,
  subtitle,
  onBack,
  action,
  focusKey,
  children,
  footer
}: {
  icon?: React.ReactNode
  feature?: Feature
  title: string
  subtitle?: string
  onBack?: () => void
  action?: React.ReactNode
  /** See `StepHeader`. */
  focusKey?: string
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <StepHeader
        icon={icon}
        feature={feature}
        title={title}
        subtitle={subtitle}
        onBack={onBack}
        action={action}
        focusKey={focusKey}
      />
      <StepBody>{children}</StepBody>
      {footer && <StepFooter>{footer}</StepFooter>}
    </>
  )
}

/** A choice that leads to another step: neutral icon box, title, hint, chevron. */
export function OptionCard({
  icon,
  feature = 'event',
  title,
  hint,
  emphasis,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  /** Only `danger` shows a hue (irreversible, `you`). Every other value is neutral. */
  feature?: Feature
  title: string
  hint: string
  /** The suggested choice: a stronger border and a raised fill. */
  emphasis?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  const danger = feature === 'danger'
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-control hover:bg-surface-hover focus-visible:outline-line-focus group flex items-center gap-3 border bg-transparent px-3.5 py-3 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-55',
        emphasis
          ? danger
            ? 'border-you bg-surface-raised'
            : 'border-line-strong bg-surface-raised'
          : 'border-line-hairline hover:border-line-strong'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'rounded-control flex size-9 shrink-0 items-center justify-center [&_svg]:size-[18px]',
          danger ? 'border-you text-you border' : NEUTRAL_TILE
        )}
      >
        {icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span
          className={cn(
            'text-[14px] font-semibold',
            danger ? 'text-you-text' : 'text-text-primary'
          )}
        >
          {title}
        </span>
        <span className="text-text-tertiary text-[12.5px] leading-[1.45]">{hint}</span>
      </span>
      <ChevronRight
        aria-hidden
        className="text-text-disabled group-hover:text-text-secondary size-4 shrink-0"
      />
    </button>
  )
}
