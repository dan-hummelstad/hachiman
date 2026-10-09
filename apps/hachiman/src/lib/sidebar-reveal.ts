import { isTextField } from '@/lib/text-field'
import type { SidebarMode, SidebarSide } from '@/stores/prefsStore'

/** N3: the hot zone at the sidebar's edge of the window that reveals a hidden sidebar. */
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

/** Whether a pointer at `x` (CSS px from the left of a `width` wide window) is in the hot zone. */
export const inHotZone = (x: number, side: SidebarSide, width: number): boolean =>
  side === 'left' ? x >= 0 && x < EDGE_PX : x < width && x >= width - EDGE_PX

/** Whether the sidebar starts hidden: the user's choice, or a narrow window. */
export const startsHidden = (mode: SidebarMode, windowWidth: number): boolean =>
  mode === 'undocked' || windowWidth < NARROW_WIDTH

/**
 * The sidebar of a window: in the layout ('docked'), out of it and not shown ('tucked'), or out
 * of it and slid in over the content ('revealed').
 */
export type SidebarView = 'docked' | 'tucked' | 'revealed'

/** The sidebar a window opens with. */
export const initialSidebar = (mode: SidebarMode, windowWidth: number): SidebarView =>
  startsHidden(mode, windowWidth) ? 'tucked' : 'docked'

/** A tucked sidebar reveals; a revealed one tucks; the dock toggle pins or unpins it. */
export type SidebarAction = 'reveal' | 'tuck' | 'toggleDock'

export function sidebarAfter(view: SidebarView, action: SidebarAction): SidebarView {
  switch (action) {
    case 'reveal':
      return view === 'tucked' ? 'revealed' : view
    case 'tuck':
      return view === 'revealed' ? 'tucked' : view
    case 'toggleDock':
      return view === 'docked' ? 'tucked' : 'docked'
  }
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
