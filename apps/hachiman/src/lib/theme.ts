import type { Theme } from '@/stores/prefsStore'

export type ResolvedTheme = 'dark' | 'light'

/** The OS dark mode. `system` follows it. */
export const DARK_QUERY = '(prefers-color-scheme: dark)'

/** The theme on `<html>`: the pref, or the OS for `system`. */
export function resolveTheme(pref: Theme, osDark: boolean): ResolvedTheme {
  if (pref === 'system') return osDark ? 'dark' : 'light'
  return pref
}
