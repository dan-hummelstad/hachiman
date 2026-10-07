import { ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Callout } from '@/components/ui/callout'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
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
 * A screen before the shell: one dialog card on the scrim over the empty window. The start-up and
 * the fatal screens use it. It is not a Radix dialog: there is nothing behind it to return to.
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
                'rounded-control flex size-9 shrink-0 items-center justify-center [&_svg]:size-[18px]',
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
  return (
    <div className="border-line-hairline -mx-[22px] -mb-[18px] flex justify-end gap-2 border-t px-[22px] py-3.5">
      {children}
    </div>
  )
}

/** The Arc dialog header of one step: icon tile, title and an optional subtitle. */
export function StepHeader({
  icon,
  feature = 'accent',
  title,
  subtitle
}: {
  icon: React.ReactNode
  feature?: Feature
  title: string
  subtitle?: string
}): React.JSX.Element {
  return (
    <DialogHeader icon={icon} feature={feature}>
      <DialogTitle>{title}</DialogTitle>
      {subtitle && <DialogDescription>{subtitle}</DialogDescription>}
    </DialogHeader>
  )
}

/** The scrolling body of one step. */
export function StepBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="-mx-[22px] grid max-h-[65vh] gap-3 overflow-y-auto px-[22px] text-sm">
      {children}
    </div>
  )
}

/** The footer strip of one step. Put a Back or Sign out first, with `mr-auto`. */
export function StepFooter({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <DialogFooter className="sm:items-center">{children}</DialogFooter>
}

/** One step of a security dialog (header, body, footer). It renders inside a DialogContent. */
export function StepFrame({
  icon,
  feature,
  title,
  subtitle,
  children,
  footer
}: {
  icon: React.ReactNode
  feature?: Feature
  title: string
  subtitle?: string
  children: React.ReactNode
  footer?: React.ReactNode
}): React.JSX.Element {
  return (
    <>
      <StepHeader icon={icon} feature={feature} title={title} subtitle={subtitle} />
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
          'rounded-control flex size-11 shrink-0 items-center justify-center [&_svg]:size-5',
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

/** A short warning box inside a window or a settings page. */
export function Warning({
  children,
  tone = 'warning'
}: {
  children: React.ReactNode
  tone?: 'warning' | 'danger' | 'info'
}): React.JSX.Element {
  return <Callout tone={tone === 'warning' ? 'caution' : tone}>{children}</Callout>
}
