import { create } from 'zustand'
import { startsHidden } from '@/lib/sidebar-reveal'
import { usePrefsStore } from '@/stores/prefsStore'

/**
 * N3: the sidebar of this window. `hidden` starts from the saved choice (prefsStore.sidebar) and
 * the window width; `revealed` is the transient hover state of a hidden sidebar.
 */
interface SidebarState {
  hidden: boolean
  revealed: boolean
}

const initialWidth = typeof window === 'undefined' ? Infinity : window.innerWidth

export const useSidebarState = create<SidebarState>()(() => ({
  hidden: startsHidden(usePrefsStore.getState().sidebar, initialWidth),
  revealed: false
}))

export const useSidebarHidden = (): boolean => useSidebarState((s) => s.hidden)
export const useSidebarRevealed = (): boolean => useSidebarState((s) => s.revealed)

/** ⌘S and the sidebar button: dock a hidden (or revealed) sidebar, else hide it. */
export function toggleSidebar(): void {
  const hidden = !useSidebarState.getState().hidden
  usePrefsStore.getState().setSidebar(hidden ? 'undocked' : 'docked')
  useSidebarState.setState({ hidden, revealed: false })
}

export const setRevealed = (revealed: boolean): void => {
  if (useSidebarState.getState().revealed !== revealed) useSidebarState.setState({ revealed })
}
