export const IS_MAC =
  typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

/** The shortcut modifier as the user's keyboard prints it. */
export const MOD_KEY = IS_MAC ? '⌘' : 'Ctrl '
