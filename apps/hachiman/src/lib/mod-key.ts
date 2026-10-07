const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

/** The shortcut modifier as the user's keyboard prints it. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl '

/** Whether `e` holds the shortcut modifier (⌘ on macOS, Ctrl elsewhere) and no other. */
export const isModKey = (e: KeyboardEvent): boolean =>
  (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey
