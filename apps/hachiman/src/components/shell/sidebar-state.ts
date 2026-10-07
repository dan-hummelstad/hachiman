import { create } from 'zustand'
import { initialSidebar, sidebarAfter, type SidebarView } from '@/lib/sidebar-reveal'
import { usePrefsStore, type SidebarMode } from '@/stores/prefsStore'

const initialWidth = typeof window === 'undefined' ? Infinity : window.innerWidth

/**
 * N3: the sidebar of this window. It starts from the saved choice (prefsStore.sidebar) and the
 * window width; 'revealed' is the transient hover state of a hidden sidebar.
 */
export const useSidebarState = create<{ view: SidebarView }>()(() => ({
  view: initialSidebar(usePrefsStore.getState().sidebar, initialWidth)
}))

export const useSidebarView = (): SidebarView => useSidebarState((s) => s.view)

/** Save `mode` and apply it to this window (Appearance → Sidebar). */
export function setSidebarMode(mode: SidebarMode): void {
  usePrefsStore.getState().setSidebar(mode)
  useSidebarState.setState({ view: mode === 'undocked' ? 'tucked' : 'docked' })
}

/** ⌘S and the sidebar button: dock a hidden (or revealed) sidebar, else hide it. */
export function toggleSidebar(): void {
  const next = sidebarAfter(useSidebarState.getState().view, 'toggleDock')
  setSidebarMode(next === 'docked' ? 'docked' : 'undocked')
}

function apply(action: 'reveal' | 'tuck'): void {
  const view = useSidebarState.getState().view
  const next = sidebarAfter(view, action)
  if (next !== view) useSidebarState.setState({ view: next })
}

export const revealSidebar = (): void => apply('reveal')
export const tuckSidebar = (): void => apply('tuck')
