import { createContext, useContext } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

/** The 36 square buttons of the kit (back, action, close): radius 8 on the hover fill. */
export const KIT_ICON_BUTTON =
  "rounded-control inline-flex size-9 shrink-0 items-center justify-center outline-none transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[19px]"

const ACTION_TONE = {
  default: 'bg-surface-hover text-text-secondary active:bg-surface-selected',
  accent: 'bg-accent-tint text-accent-text active:bg-accent-primary/30'
} as const

/**
 * The right-hand button of the Nav Bar (36, icon 19). Accent tone for a create action ("+ Create
 * role", M53). Takes all button props, so a menu trigger can wrap it with `asChild`.
 */
export function NavActionButton({
  label,
  tone = 'default',
  className,
  type = 'button',
  ...props
}: Omit<React.ComponentProps<'button'>, 'aria-label'> & {
  /** Accessible name. */
  label: string
  tone?: keyof typeof ACTION_TONE
}): React.JSX.Element {
  return (
    <button
      type={type}
      aria-label={label}
      data-slot="nav-action"
      className={cn(KIT_ICON_BUTTON, ACTION_TONE[tone], className)}
      {...props}
    />
  )
}

/** The element of the Nav Bar that holds the action; null until the bar mounts. */
const NavActionSlot = createContext<HTMLElement | null>(null)

/**
 * Gives `NavAction`s under it the action slot of a Nav Bar. `PushedScreen` sets it up. With a
 * hand-built `NavBar`, keep the slot in state (`const [slot, setSlot] = useState<HTMLDivElement |
 * null>(null)`), pass `slotRef={setSlot}` to the bar and `slot` here.
 */
export function NavActionProvider({
  slot,
  children
}: {
  slot: HTMLElement | null
  children: React.ReactNode
}): React.JSX.Element {
  return <NavActionSlot.Provider value={slot}>{children}</NavActionSlot.Provider>
}

/**
 * Puts its children into the right-hand slot of the enclosing screen's Nav Bar (spec §2.6). The
 * children stay in the page's React tree (its state, context and handlers), so the page owns its
 * action: `<NavAction><NavActionButton label="Create role" tone="accent" onClick={…}>…`.
 */
export function NavAction({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const slot = useContext(NavActionSlot)
  return slot ? createPortal(children, slot) : null
}

/**
 * Mobile / Nav Bar (kit J1oV5): 52 high, padding 0/12/0/10. Back 36, title 17/800 with an
 * optional subtitle 12.5/500, then the action slot. The title takes the focus on a push, so it has
 * `tabIndex={-1}` and `titleRef`.
 */
export function NavBar({
  title,
  subtitle,
  onBack,
  backLabel = 'Back',
  action,
  titleId,
  titleRef,
  slotRef,
  className
}: {
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Omit for a root screen with no Back. */
  onBack?: () => void
  backLabel?: string
  /** An action from the screen's owner. Pages add theirs with `NavAction`. */
  action?: React.ReactNode
  titleId?: string
  titleRef?: React.Ref<HTMLHeadingElement>
  /** The slot element that `NavAction` renders into (see `NavActionProvider`). */
  slotRef?: React.Ref<HTMLDivElement>
  className?: string
}): React.JSX.Element {
  return (
    <div
      data-slot="nav-bar"
      className={cn('flex h-[52px] shrink-0 items-center gap-2.5 pr-3 pl-2.5', className)}
    >
      {onBack && (
        <button
          type="button"
          aria-label={backLabel}
          onClick={onBack}
          className={cn(
            KIT_ICON_BUTTON,
            'bg-surface-hover text-text-secondary active:bg-surface-selected [&_svg]:size-5'
          )}
        >
          <ChevronLeft />
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <h1
          id={titleId}
          ref={titleRef}
          tabIndex={-1}
          className="text-text-primary truncate text-[17px] leading-5 font-extrabold outline-none"
        >
          {title}
        </h1>
        {subtitle && (
          <p className="text-text-tertiary truncate text-[12.5px] leading-[15px] font-medium">
            {subtitle}
          </p>
        )}
      </div>
      <div ref={slotRef} data-slot="nav-actions" className="flex shrink-0 items-center gap-2">
        {action}
      </div>
    </div>
  )
}
