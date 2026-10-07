import { create } from 'zustand'

/** 'open': Enter opens, ⌘Enter pins. 'pin' (the tab bar's "+"): Enter pins. */
export type SwitcherMode = 'open' | 'pin'

/** The quick switcher (N5): null = closed. */
export const useSwitcher = create<{ mode: SwitcherMode | null }>()(() => ({ mode: null }))

export const openSwitcher = (mode: SwitcherMode = 'open'): void => useSwitcher.setState({ mode })
export const closeSwitcher = (): void => useSwitcher.setState({ mode: null })
export const isSwitcherOpen = (): boolean => useSwitcher.getState().mode !== null
