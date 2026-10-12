import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

/**
 * Docked foot of a mobile screen (kit "Docked foot", M52): padding 12/16/4/16 for one 48 primary
 * button, a 6 gap for a second one under it, then the home-indicator inset. With no inset (iPhone
 * SE) the bottom pad is 16, as in a sheet, so the button does not sit on the screen edge. It takes
 * the colour of the panel it sits on. While the keyboard is up the inset goes away, because the
 * foot then rides on the keyboard (`data-keyboard` on `<html>`, spec §2.8).
 */
export function MobileFoot({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="mobile-foot"
      className={cn(
        'flex shrink-0 flex-col gap-1.5 px-4 pt-3 pb-[max(16px,calc(4px+var(--safe-bottom,0px)))] in-data-[keyboard=open]:pb-1',
        className
      )}
      {...props}
    />
  )
}

/**
 * Docks a mobile Save foot (`SaveBar layout="foot"`) under the panel of the pushed screen that
 * holds `anchor`, where M48 and M49 draw it: at the foot of the screen, under the last row, also
 * when rows of the screen come after the page (ACCESS and Delete channel under the overview of
 * M48). Outside a pushed screen it stays in place. The foot is then outside the DOM of a form, so
 * its Save button takes `onSave`, not a submit.
 */
export function DockedFoot({
  anchor,
  children
}: {
  /** An element of the page, once mounted. */
  anchor: HTMLElement | null
  children: React.ReactNode
}): React.ReactNode {
  if (!anchor) return null
  const screen = anchor.closest<HTMLElement>('[data-slot="pushed-screen"]')
  if (!screen) return children
  // `SaveBar` spans the 16 px padding of its parent; this wrapper gives it that padding.
  return createPortal(
    <div data-slot="docked-foot" className="shrink-0 px-4">
      {children}
    </div>,
    screen
  )
}
