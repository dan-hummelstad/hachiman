import { useEffect, useRef } from 'react'
import { captureOpener, restoreFocus } from '@/lib/focus-opener'
import type { DrawerSide } from '@/lib/mobile-drawer'
import { cn } from '@/lib/utils'

/** The slide of the drawers and sheets. The reduced-motion rule in main.css removes it. */
const SLIDE = 'duration-250 ease-[cubic-bezier(.32,.72,0,1)]'

const PANEL: Record<DrawerSide, string> = {
  left: 'left-0 border-r shadow-drawer',
  right: 'right-0 border-l shadow-drawer-right'
}

/**
 * A mobile drawer (docs/ios-mobile-ui-spec.md §2.4) over the chat: `min(320px, 100vw - 73px)`
 * wide, full height, from its side of the screen, over a scrim (`--surface-scrim-drawer`) that
 * closes it on a tap. It stays mounted while closed (inert and off screen), so what it holds
 * keeps its state. While a finger drags it, `progress` (its open share, 0–1) places it and the
 * slide stops.
 *
 * A dialog (`aria-modal`) while open: it takes the focus, Escape closes it, and the focus goes
 * back to the control that opened it. VoiceOver and Voice Control do not reach the scrim (it is
 * outside the modal), so the right drawer, whose column has no close of its own, starts with a
 * hidden labelled close that shows on keyboard focus. The sidebar shows its own close.
 */
export function Drawer({
  side,
  open,
  progress = null,
  onClose,
  label,
  closeLabel,
  className,
  children
}: {
  side: DrawerSide
  open: boolean
  /** The open share while a finger drags the drawer, else null. */
  progress?: number | null
  onClose: () => void
  /** The accessible name of the drawer ("Sidebar", "Members"). */
  label: string
  /** The accessible name of the scrim ("Close sidebar"), and of the right drawer's own close. */
  closeLabel: string
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])

  useEffect(() => {
    if (!open) return
    const node = panel.current
    const opener = captureOpener()
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true })
    // Radix layers take their Escape first (capture on the document) and mark it handled.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target
      if (target !== document.body && !(target instanceof Node && node?.contains(target))) return
      e.preventDefault()
      close.current()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      // The closed drawer is inert, so a focus inside it is gone by now. Elsewhere it stays.
      const active = document.activeElement
      if (active === null || active === document.body || node?.contains(active))
        restoreFocus(opener)
    }
  }, [open])

  const dragging = progress !== null
  const share = dragging ? progress : open ? 1 : 0
  const away = side === 'left' ? -1 : 1

  return (
    <>
      <button
        type="button"
        aria-label={closeLabel}
        inert={!open}
        onClick={onClose}
        style={{ opacity: share }}
        className={cn(
          'bg-surface-scrim-drawer absolute inset-0 z-40 cursor-default',
          !open && 'pointer-events-none',
          !dragging && cn('transition-opacity', SLIDE)
        )}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal={open || undefined}
        aria-label={label}
        tabIndex={-1}
        inert={!open}
        data-slot="drawer"
        data-side={side}
        data-state={open ? 'open' : 'closed'}
        style={{ transform: `translate3d(${away * (1 - share) * 100}%, 0, 0)` }}
        className={cn(
          'border-line-sheet absolute inset-y-0 z-40 flex w-[min(320px,calc(100vw-73px))] flex-col outline-none',
          PANEL[side],
          // A closed drawer casts no shadow onto the screen edge.
          !open && !dragging && 'shadow-none',
          !dragging && cn('transition-[transform,box-shadow]', SLIDE),
          className
        )}
      >
        {side === 'right' && (
          <button
            type="button"
            onClick={onClose}
            className="bg-surface-content text-text-primary rounded-control outline-line-focus sr-only z-10 px-3 py-2 text-sm font-semibold focus-visible:not-sr-only focus-visible:absolute focus-visible:top-[calc(var(--safe-top,0px)+8px)] focus-visible:left-3 focus-visible:outline-2"
          >
            {closeLabel}
          </button>
        )}
        {children}
      </div>
    </>
  )
}
