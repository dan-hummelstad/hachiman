import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react'
import { countLocalPushed } from '@/components/mobile/drawer-state'
import { MobileFoot } from '@/components/mobile/foot'
import { NavActionProvider, NavBar } from '@/components/mobile/nav-bar'
import { WALLPAPER } from '@/components/shell/wallpaper'
import { captureOpener, restoreFocus } from '@/lib/focus-opener'
import { cn } from '@/lib/utils'

/** The push and pop slide, as the drawers and sheets (spec §2.4). */
const SLIDE_MS = 250
/** The unmount after a pop when no `animationend` comes (no animation ran). */
const UNMOUNT_MS = SLIDE_MS + 100

/** The closed state keeps the last frame (off screen) until the screen unmounts. */
const SLIDE =
  'duration-250 ease-[cubic-bezier(.32,.72,0,1)] data-[state=open]:animate-in data-[state=open]:slide-in-from-right data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=closed]:[--tw-animation-fill-mode:forwards]'

/** Navigation of a screen that a `ScreenStackProvider` pushed. */
interface StackedScreen {
  /** False while the stack pops it. */
  open: boolean
  pop: () => void
}

const StackedScreenContext = createContext<StackedScreen | null>(null)

export interface ScreenStack {
  /**
   * Shows `screen` (a `PushedScreen`) over the provider's content. It is rendered as given, so
   * pass an element whose component reads its own data (a role editor that takes a role id).
   */
  push: (screen: React.ReactNode) => void
  /** Slides the pushed screen out. */
  pop: () => void
}

const ScreenStackContext = createContext<ScreenStack | null>(null)

/**
 * Depth 2 inside a pushed screen (role editor, quiet hours; spec §2.6): React state, one level, not
 * persisted. Wrap the whole parent screen, so the parent is inert while a screen covers it. A
 * `PushedScreen` that the stack shows gets `pop` as its default Back.
 */
export function ScreenStackProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [screen, setScreen] = useState<React.ReactNode>(null)
  const [open, setOpen] = useState(false)
  const stack = useMemo<ScreenStack>(
    () => ({
      push: (next) => {
        setScreen(next)
        setOpen(true)
      },
      pop: () => setOpen(false)
    }),
    []
  )
  const stacked = useMemo<StackedScreen>(() => ({ open, pop: stack.pop }), [open, stack])

  // The MobileShell's edge swipe means Back while this stack shows a screen.
  useEffect(() => {
    if (!open) return
    countLocalPushed(1)
    return () => countLocalPushed(-1)
  }, [open])

  // Drop the screen once it has slid out. It renders nothing from the end of its slide.
  useEffect(() => {
    if (open || screen === null) return
    const t = setTimeout(() => setScreen(null), UNMOUNT_MS)
    return () => clearTimeout(t)
  }, [open, screen])

  return (
    <ScreenStackContext.Provider value={stack}>
      <div className="contents" inert={open}>
        {children}
      </div>
      <StackedScreenContext.Provider value={stacked}>{screen}</StackedScreenContext.Provider>
    </ScreenStackContext.Provider>
  )
}

/** `push` and `pop` of the enclosing `ScreenStackProvider`. */
// eslint-disable-next-line react-refresh/only-export-components
export function usePushScreen(): ScreenStack {
  const stack = useContext(ScreenStackContext)
  if (!stack) throw new Error('usePushScreen must be used within a <ScreenStackProvider>')
  return stack
}

/**
 * Template · Pushed screen (kit n3TQN): the safe top and the 52 Nav Bar on the tinted window, then
 * a square panel (content colour, top hairline) whose body scrolls (padding 16, gap 10), then an
 * optional docked foot (`MobileFoot`) and the safe bottom. It covers the viewport above the chat
 * card (z-30, under drawers and sheets).
 *
 * It slides in from the right while `open` turns true and out while it turns false, then renders
 * nothing. Keep it mounted with `open` and its last content (`useLatched`), so it can slide out. The
 * nav title takes the focus on a push; the opener gets it back on a pop. Pages put a Nav Bar
 * action with `NavAction`.
 *
 * It makes only itself inert (`covered`, or while it slides out). What lies under it is the
 * owner's job: at depth 2 `ScreenStackProvider` makes the parent inert; at depth 1 the MobileShell
 * makes the chat card and the closed drawers inert while a pushed screen shows (spec §2.3, A1),
 * so VoiceOver and Tab do not leave the screen.
 */
export function PushedScreen({
  open = true,
  title,
  subtitle,
  onBack,
  backLabel,
  action,
  toolbar,
  foot,
  covered = false,
  className,
  bodyClassName,
  children
}: {
  open?: boolean
  title: React.ReactNode
  subtitle?: React.ReactNode
  /** Default: `pop` of the stack that pushed this screen. */
  onBack?: () => void
  backLabel?: string
  /** The Nav Bar action from the screen's owner (`NavActionButton`). */
  action?: React.ReactNode
  /** A row on the tinted window under the Nav Bar (the section tabs of M52). */
  toolbar?: React.ReactNode
  /** The docked foot: one 48 primary button, maybe a second under it. */
  foot?: React.ReactNode
  /** Another screen lies on top: inert, so VoiceOver and Tab skip it. */
  covered?: boolean
  className?: string
  bodyClassName?: string
  children?: React.ReactNode
}): React.JSX.Element | null {
  const stacked = useContext(StackedScreenContext)
  const shown = open && (stacked?.open ?? true)
  const [present, setPresent] = useState(shown)
  if (shown && !present) setPresent(true)

  useEffect(() => {
    if (shown || !present) return
    const t = setTimeout(() => setPresent(false), UNMOUNT_MS)
    return () => clearTimeout(t)
  }, [shown, present])
  const onAnimationEnd = (e: React.AnimationEvent<HTMLElement>): void => {
    if (e.target === e.currentTarget && !shown) setPresent(false)
  }

  const section = useRef<HTMLElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!shown) return
    // The section stays mounted until the slide out ends, so this node is the one of the pop.
    const node = section.current
    const opener = captureOpener()
    titleRef.current?.focus({ preventScroll: true })
    return () => {
      // Give the focus back only when it is still here (Back) or nowhere.
      const active = document.activeElement
      const here = active === null || active === document.body || node?.contains(active)
      if (here) restoreFocus(opener)
    }
  }, [shown])

  const titleId = useId()
  const [slot, setSlot] = useState<HTMLDivElement | null>(null)

  if (!present) return null
  return (
    <section
      ref={section}
      aria-labelledby={titleId}
      data-slot="pushed-screen"
      data-state={shown ? 'open' : 'closed'}
      inert={covered || !shown}
      onAnimationEnd={onAnimationEnd}
      className={cn(
        'fixed inset-x-0 top-0 z-30 flex h-[var(--app-height,100dvh)] flex-col pt-[var(--safe-top,0px)]',
        // The tinted window behind the nav bar (`components/shell/wallpaper.ts`). The
        // `--wallpaper-*` vars come from the MobileShell root.
        WALLPAPER,
        SLIDE,
        className
      )}
    >
      <NavBar
        title={title}
        subtitle={subtitle}
        onBack={onBack ?? stacked?.pop}
        backLabel={backLabel}
        action={action}
        titleId={titleId}
        titleRef={titleRef}
        slotRef={setSlot}
      />
      {toolbar}
      <div className="bg-surface-content border-line-hairline flex min-h-0 flex-1 flex-col border-t">
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain p-4',
            !foot && 'pb-[calc(16px+var(--safe-bottom,0px))] in-data-[keyboard=open]:pb-4',
            // A foot docked by the page (`DockedFoot` in settings/channel-overview) keeps the inset.
            '[[data-slot=pushed-screen]:has(>[data-slot=docked-foot])>div>&]:pb-4',
            bodyClassName
          )}
        >
          <NavActionProvider slot={slot}>{children}</NavActionProvider>
        </div>
        {foot && <MobileFoot>{foot}</MobileFoot>}
      </div>
    </section>
  )
}
