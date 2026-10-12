import { actionsFor, type KeybindAction, type Keybinds } from '@/lib/keybinds'

/**
 * The app-wide keys (N1, N2, N3, N5, settings): the rebindable actions (lib/keybinds.ts), and the
 * fixed ⌘1–⌘9 for the pinned tabs and Esc out of settings. ⌘ is Ctrl on Windows and Linux.
 */
export type Shortcut =
  { kind: KeybindAction } | { kind: 'tab'; index: number } | { kind: 'leaveSettings' }

/** The shortcut of a key press: `combo` is `comboOf(e)`, `binds` the user's keybinds. */
export function matchShortcut(combo: string | null, binds: Keybinds): Shortcut | null {
  if (combo === null) return null
  if (combo === 'Escape') return { kind: 'leaveSettings' }
  const tab = /^Mod\+Digit([1-9])$/.exec(combo)
  if (tab) return { kind: 'tab', index: Number(tab[1]) - 1 }
  const [action] = actionsFor(combo, binds)
  return action ? { kind: action } : null
}

/** Whether a key press happens under a modal dialog: the shortcuts then do nothing. */
export function underModal(target: EventTarget | null, dialogOpen: boolean): boolean {
  if (dialogOpen) return true
  const el = target as Element | null
  return el?.closest?.('[data-slot="dialog-content"], [role="alertdialog"], [data-sheet]') != null
}
