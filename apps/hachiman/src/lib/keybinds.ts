import { IS_MAC } from '@/lib/mod-key'

/**
 * The rebindable keys. A combo is a string: the modifiers in the order `Mod`, `Ctrl`, `Alt`,
 * `Shift`, then the key, joined by `+` (`Mod+Shift+KeyM`). `Mod` is ⌘ on macOS and Ctrl
 * elsewhere; `Ctrl` is the macOS Control key only. The key is a `KeyboardEvent.code`, except that
 * a letter follows the keyboard layout (`comboOf`).
 */
export type KeybindAction =
  'switcher' | 'sidebar' | 'back' | 'forward' | 'toggleMute' | 'toggleDeafen' | 'pushToTalk'

export interface KeybindSpec {
  id: KeybindAction
  label: string
  group: 'Navigation' | 'Voice'
  /** null: no key until the user sets one. */
  default: string | null
  /** The desktop app can register it with the OS, so it works while Hachiman is in the background. */
  global?: boolean
}

export const KEYBINDS: readonly KeybindSpec[] = [
  { id: 'switcher', label: 'Open the quick switcher', group: 'Navigation', default: 'Mod+KeyK' },
  { id: 'sidebar', label: 'Show or hide the sidebar', group: 'Navigation', default: 'Mod+KeyS' },
  { id: 'back', label: 'Go back', group: 'Navigation', default: 'Mod+BracketLeft' },
  { id: 'forward', label: 'Go forward', group: 'Navigation', default: 'Mod+BracketRight' },
  {
    id: 'toggleMute',
    label: 'Mute or unmute',
    group: 'Voice',
    default: 'Mod+Shift+KeyM',
    global: true
  },
  {
    id: 'toggleDeafen',
    label: 'Deafen or undeafen',
    group: 'Voice',
    default: 'Mod+Shift+KeyD',
    global: true
  },
  { id: 'pushToTalk', label: 'Push to talk (hold)', group: 'Voice', default: null }
]

/** Keys that cannot be rebound. Shown read-only; a rebind to one of them is refused. */
export const FIXED_KEYBINDS: readonly { label: string; combos: string[] }[] = [
  {
    label: 'Open pinned tab 1–9',
    combos: Array.from({ length: 9 }, (_, i) => `Mod+Digit${i + 1}`)
  },
  { label: 'Close settings', combos: ['Escape'] },
  { label: 'Edit your last message (empty message field)', combos: ['ArrowUp'] }
]

/** The user's changes: an action → its combo, or null for no key. A missing action keeps its default. */
export type KeybindOverrides = Partial<Record<KeybindAction, string | null>>
export type Keybinds = Record<KeybindAction, string | null>

export function resolveKeybinds(overrides: KeybindOverrides): Keybinds {
  const out = {} as Keybinds
  for (const k of KEYBINDS) out[k.id] = k.id in overrides ? (overrides[k.id] ?? null) : k.default
  return out
}

export type KeyEventLike = Pick<
  KeyboardEvent,
  'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'
>

/** The `KeyboardEvent.key` of a modifier. */
export const MODIFIER_KEYS = new Set([
  'Meta',
  'Control',
  'Alt',
  'Shift',
  'AltGraph',
  'CapsLock',
  'OS'
])

/** The key part of a press: a letter by its layout (so ⌘K follows Dvorak), any other key by its position. */
export function keyOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string {
  return /^[a-z]$/i.test(e.key) ? `Key${e.key.toUpperCase()}` : e.code
}

/** The combo of a key press, or null for a modifier on its own or a combo the app does not use. */
export function comboOf(e: KeyEventLike, mac = IS_MAC): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = keyOf(e)
  if (!key) return null
  // ⊞ Win on Windows and Linux belongs to the OS.
  if (!mac && e.metaKey) return null
  const mod = mac ? e.metaKey : e.ctrlKey
  const ctrl = mac && e.ctrlKey
  return [mod && 'Mod', ctrl && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', key]
    .filter(Boolean)
    .join('+')
}

export function splitCombo(combo: string): { mods: string[]; key: string } {
  const parts = combo.split('+')
  return { mods: parts.slice(0, -1), key: parts[parts.length - 1] }
}

/** Whether the combo holds ⌘ / Ctrl / Alt (Shift alone still types). An F-key counts as held. */
export function hasCommandModifier(combo: string): boolean {
  const { mods, key } = splitCombo(combo)
  return mods.some((m) => m !== 'Shift') || /^F\d{1,2}$/.test(key)
}

const PUNCTUATION: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Space: 'Space',
  Enter: 'Enter'
}

const KEY_LABELS: Record<string, string> = {
  ...PUNCTUATION,
  Escape: 'Esc',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→'
}

export function keyLabel(key: string): string {
  if (key in KEY_LABELS) return KEY_LABELS[key]
  const m = /^(?:Key|Digit)(.)$/.exec(key) ?? /^Numpad(\d)$/.exec(key)
  return m ? m[1] : key
}

/** The combo as the user's keyboard prints it: `⌘⇧M` on macOS, `Ctrl+Shift+M` elsewhere. */
export function formatCombo(combo: string, mac = IS_MAC): string {
  const { mods, key } = splitCombo(combo)
  const macMods: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' }
  const pcMods: Record<string, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }
  if (mac) return mods.map((m) => macMods[m]).join('') + keyLabel(key)
  return [...mods.map((m) => pcMods[m]), keyLabel(key)].join('+')
}

export function actionsFor(combo: string, binds: Keybinds): KeybindAction[] {
  return KEYBINDS.filter((k) => binds[k.id] === combo).map((k) => k.id)
}

/** The fixed key that `combo` would take over, or null. */
export function reservedBy(combo: string): string | null {
  return FIXED_KEYBINDS.find((f) => f.combos.includes(combo))?.label ?? null
}

const ACCELERATOR_KEYS: Record<string, string> = {
  ...PUNCTUATION,
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  NumpadAdd: 'numadd',
  NumpadSubtract: 'numsub',
  NumpadMultiply: 'nummult',
  NumpadDivide: 'numdiv',
  NumpadDecimal: 'numdec'
}

/**
 * The Electron accelerator of a combo, for a global shortcut. Null when the combo has no ⌘ /
 * Ctrl / Alt (it would take a typing key from every app) or a key that accelerators lack.
 */
export function toAccelerator(combo: string): string | null {
  if (!hasCommandModifier(combo)) return null
  const { mods, key } = splitCombo(combo)
  const m = /^(?:Key|Digit)(.)$/.exec(key)
  const accKey = m
    ? m[1]
    : /^F\d{1,2}$/.test(key)
      ? key
      : /^Numpad\d$/.test(key)
        ? `num${key.slice(6)}`
        : ACCELERATOR_KEYS[key]
  if (!accKey) return null
  const accMods: Record<string, string> = {
    Mod: 'CommandOrControl',
    Ctrl: 'Control',
    Alt: 'Alt',
    Shift: 'Shift'
  }
  return [...mods.map((x) => accMods[x]), accKey].join('+')
}
