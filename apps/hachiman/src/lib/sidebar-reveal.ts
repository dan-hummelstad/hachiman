import type { SidebarMode } from '@/stores/prefsStore'

/** N3: the hot zone at the left edge of the window that reveals a hidden sidebar. */
export const EDGE_PX = 8
/** The slide-in time of a revealed sidebar. */
export const REVEAL_MS = 150
/** The time between the pointer leaving a revealed sidebar and the hide. */
export const HIDE_DELAY_MS = 300
/** Below this window width the sidebar starts hidden. */
export const NARROW_WIDTH = 1100

/** What keeps a revealed sidebar out: a menu, a drag or a focused text field in it. */
export interface RevealHolds {
  menuOpen: boolean
  dragging: boolean
  fieldFocused: boolean
}

/** Whether a revealed sidebar may hide now. */
export const canHide = (h: RevealHolds): boolean => !h.menuOpen && !h.dragging && !h.fieldFocused

/** Whether a pointer at `x` (CSS px from the left edge of the window) is in the hot zone. */
export const inHotZone = (x: number): boolean => x >= 0 && x < EDGE_PX

/** Whether the sidebar starts hidden: the user's choice, or a narrow window. */
export const startsHidden = (mode: SidebarMode, windowWidth: number): boolean =>
  mode === 'undocked' || windowWidth < NARROW_WIDTH

/** Whether `el` takes text: an input, a textarea or a contenteditable element. */
export function isTextField(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(
      type
    )
  }
  return (el as HTMLElement).isContentEditable === true
}

/** The holds of a revealed sidebar `root` now. `dragging` comes from the caller's pointer state. */
export function holdsOf(
  root: HTMLElement,
  dragging: boolean,
  doc: Document = document
): RevealHolds {
  const active = doc.activeElement
  return {
    // A Radix trigger whose menu, popover or context menu is open.
    menuOpen:
      root.querySelector(
        '[aria-haspopup][aria-expanded="true"], [data-slot="context-menu-trigger"][data-state="open"]'
      ) !== null,
    dragging,
    fieldFocused: active !== null && root.contains(active) && isTextField(active)
  }
}
