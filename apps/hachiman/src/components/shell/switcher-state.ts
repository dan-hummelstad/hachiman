import { useEffect } from 'react'
import { create } from 'zustand'
import { isModKey } from '@/lib/mod-key'
import { useDialogStore } from '@/stores/dialogStore'

/** 'open': Enter opens, ⌘Enter pins. 'pin' (the tab bar's "+"): Enter pins. */
export type SwitcherMode = 'open' | 'pin'

/** The quick switcher (N5): null = closed. */
export const useSwitcher = create<{ mode: SwitcherMode | null }>()(() => ({ mode: null }))

export const openSwitcher = (mode: SwitcherMode = 'open'): void => useSwitcher.setState({ mode })
export const closeSwitcher = (): void => useSwitcher.setState({ mode: null })
export const isSwitcherOpen = (): boolean => useSwitcher.getState().mode !== null

/** Whether a modal dialog is open (⌘K does not open the switcher over one). */
function modalOpen(): boolean {
  return (
    useDialogStore.getState().dialog !== null ||
    document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]') !== null
  )
}

/** ⌘K (Ctrl K) from anywhere except a modal dialog: toggles the switcher. Mount once. */
export function useSwitcherShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key.toLowerCase() !== 'k' || !isModKey(e)) return
      if (isSwitcherOpen()) {
        e.preventDefault()
        return closeSwitcher()
      }
      if (modalOpen()) return
      e.preventDefault()
      openSwitcher('open')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
