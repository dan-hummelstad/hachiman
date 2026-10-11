import { useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react'
import { MobileFoot } from '@/components/mobile/foot'
import { NavBar } from '@/components/mobile/nav-bar'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { StepScreenContext, useStepLayout } from '@/components/security/onboarding-steps'
import { useLayout } from '@/hooks/use-layout'
import { HOME_WALLPAPER } from '@/lib/guild-tint'
import { cn } from '@/lib/utils'

/**
 * The window frame with no content (decision 3 of the Arc plan): the wallpaper, an empty sidebar
 * strip and an empty content card. The screens before the shell (encryption start-up, set-up,
 * fatal stops) show their dialog on the scrim over it, never over decrypted content.
 */
export function EmptyWindow({ children }: { children?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="bg-surface-window relative flex min-h-0 w-full flex-1">
      <div aria-hidden className="hidden w-[280px] shrink-0 p-2.5 sm:block">
        <div className="bg-surface-hover rounded-control h-8" />
      </div>
      <div
        aria-hidden
        className="border-line-hairline bg-surface-content mt-2 mr-2 mb-2 ml-2 flex-1 border sm:ml-0"
      />
      {children}
    </div>
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
      style={{ backgroundImage: HOME_WALLPAPER }}
      className="bg-surface-window flex min-h-0 w-full flex-1 flex-col pt-(--safe-top,0px)"
    >
      <div ref={setNav} className="shrink-0" />
      <div className="bg-surface-content border-line-hairline text-text-primary flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain border-t px-4 pt-4 pb-[calc(16px+var(--safe-bottom,0px))] text-[15px] leading-[1.45] in-data-[keyboard=open]:pb-4 has-[[data-slot=mobile-foot]]:pb-0">
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
          feature={tone === 'danger' ? 'danger' : 'voice'}
          title={title}
        />
        {children}
      </StepScreen>
    )
  }
  return (
    <EmptyWindow>
      <div className="bg-surface-scrim absolute inset-0 flex items-center justify-center overflow-y-auto p-4">
        <section
          aria-labelledby="screen-window-title"
          className={cn(
            'bg-surface-content text-text-primary border-line-hairline shadow-soft my-auto grid w-full gap-4 border px-[22px] pb-[18px]',
            wide ? 'max-w-[560px]' : 'max-w-[500px]'
          )}
        >
          <header className="flex items-center gap-3 pt-4">
            <span
              aria-hidden
              className={cn(
                'flex size-9 shrink-0 items-center justify-center [&_svg]:size-[18px]',
                FEATURE_TILE[tone === 'danger' ? 'danger' : 'voice']
              )}
            >
              {tone === 'danger' ? <ShieldAlert /> : <ShieldCheck />}
            </span>
            <h1 id="screen-window-title" className="text-[18px] leading-6 font-extrabold">
              {title}
            </h1>
          </header>
          {children}
        </section>
      </div>
    </EmptyWindow>
  )
}

/** The footer strip of a ScreenWindow: a hairline on top, the actions on the right. */
export function ScreenActions({ children }: { children: React.ReactNode }): React.JSX.Element {
  if (useStepLayout() === 'screen') return <StepFooter>{children}</StepFooter>
  return (
    <div className="border-line-hairline -mx-[22px] -mb-[18px] flex justify-end gap-2 border-t px-[22px] py-3.5">
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
  icon,
  feature = 'accent',
  title,
  subtitle,
  onBack,
  action,
  focusKey
}: {
  icon: React.ReactNode
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
    <DialogHeader icon={icon} feature={feature}>
      <DialogTitle>{title}</DialogTitle>
      {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
    </DialogHeader>
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
    <div className="-mx-[22px] grid max-h-[65vh] gap-3 overflow-y-auto px-[22px] text-sm">
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
      <MobileFoot className="bg-surface-content sticky bottom-0 z-10 -mx-4 mt-auto [&>[data-slot=button]]:h-12 [&>[data-slot=button]]:w-full [&>[data-slot=button]]:text-[15px] [&>[data-slot=button]]:font-extrabold">
        {children}
      </MobileFoot>
    )
  }
  return <DialogFooter className="sm:items-center">{children}</DialogFooter>
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
  icon: React.ReactNode
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

/** A choice that leads to another step: icon tile in the feature colour, title, hint, chevron. */
export function OptionCard({
  icon,
  feature = 'accent',
  title,
  hint,
  emphasis,
  disabled,
  onClick
}: {
  icon: React.ReactNode
  feature?: Feature
  title: string
  hint: string
  /** The suggested choice: its border takes the feature colour. */
  emphasis?: boolean
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-option bg-surface-raised hover:bg-surface-hover focus-visible:outline-line-focus group flex items-center gap-3 border px-3.5 py-3 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 disabled:pointer-events-none disabled:opacity-55',
        emphasis
          ? feature === 'danger'
            ? 'border-feature-danger'
            : 'border-accent-primary'
          : 'border-line-hairline hover:border-line-strong'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'flex size-11 shrink-0 items-center justify-center [&_svg]:size-5',
          FEATURE_TILE[feature]
        )}
      >
        {icon}
      </span>
      <span className="grid min-w-0 flex-1 gap-0.5">
        <span
          className={cn(
            'text-label',
            feature === 'danger' ? 'text-feature-danger-text' : 'text-text-primary'
          )}
        >
          {title}
        </span>
        <span className="text-meta text-text-secondary">{hint}</span>
      </span>
      <ChevronRight
        aria-hidden
        className="text-text-tertiary group-hover:text-text-primary size-4 shrink-0"
      />
    </button>
  )
}
