import { useMemo } from 'react'
import { create } from 'zustand'
import { formatCombo, resolveKeybinds, type KeybindAction, type Keybinds } from '@/lib/keybinds'
import { usePrefsStore } from '@/stores/prefsStore'

/** Keybind state of this window, not persisted. */
interface KeybindRuntime {
  /** The settings page records a combo: no keybind acts, and the global ones are let go. */
  recording: boolean
  /** The actions that the desktop host holds as global shortcuts (they skip the in-app handler). */
  globalActive: KeybindAction[]
  /** The global actions that the OS refused (another app holds the combo). */
  globalFailed: KeybindAction[]
}

export const useKeybindRuntime = create<KeybindRuntime>()(() => ({
  recording: false,
  globalActive: [],
  globalFailed: []
}))

/** The user's keybinds, defaults filled in. */
export function useKeybinds(): Keybinds {
  const overrides = usePrefsStore((s) => s.keybinds)
  return useMemo(() => resolveKeybinds(overrides), [overrides])
}

/** The keybinds outside React. */
export const currentKeybinds = (): Keybinds => resolveKeybinds(usePrefsStore.getState().keybinds)

/** The key of `action` as the keyboard prints it (`⌘K`), or null when it has none. */
export function useKeybindLabel(action: KeybindAction): string | null {
  const combo = usePrefsStore((s) =>
    action in s.keybinds ? (s.keybinds[action] ?? null) : undefined
  )
  return useMemo(() => {
    const c = combo === undefined ? resolveKeybinds({})[action] : combo
    return c ? formatCombo(c) : null
  }, [action, combo])
}
