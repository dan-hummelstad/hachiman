/**
 * The app-wide keys (N1, N2, N3, N5, settings): ⌘[ / ⌘] back and forward, ⌘1–⌘9 the pinned
 * tabs, ⌘S the sidebar, ⌘K the quick switcher, Esc out of settings. ⌘ is Ctrl on Windows and
 * Linux.
 */
export type Shortcut =
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'tab'; index: number }
  | { kind: 'sidebar' }
  | { kind: 'switcher' }
  | { kind: 'leaveSettings' }

/** The shortcut of a key press: `key` is KeyboardEvent.key, `mod` whether only ⌘ is held. */
export function matchShortcut(key: string, mod: boolean): Shortcut | null {
  if (!mod) return key === 'Escape' ? { kind: 'leaveSettings' } : null
  const k = key.toLowerCase()
  if (k === '[') return { kind: 'back' }
  if (k === ']') return { kind: 'forward' }
  if (k === 's') return { kind: 'sidebar' }
  if (k === 'k') return { kind: 'switcher' }
  if (k.length === 1 && k >= '1' && k <= '9') return { kind: 'tab', index: Number(k) - 1 }
  return null
}

/** Whether a key press happens under a modal dialog: the shortcuts then do nothing. */
export function underModal(target: EventTarget | null, dialogOpen: boolean): boolean {
  if (dialogOpen) return true
  const el = target as Element | null
  return el?.closest?.('[data-slot="dialog-content"], [role="alertdialog"]') != null
}
