import { describe, expect, it } from 'vitest'
import {
  actionsFor,
  comboOf,
  formatCombo,
  reservedBy,
  resolveKeybinds,
  toAccelerator,
  type KeyEventLike
} from '@/lib/keybinds'

const press = (key: string, code: string, mods: Partial<KeyEventLike> = {}): KeyEventLike => ({
  key,
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods
})

describe('comboOf', () => {
  it('reads ⌘ on macOS and Ctrl elsewhere as Mod', () => {
    expect(comboOf(press('k', 'KeyK', { metaKey: true }), true)).toBe('Mod+KeyK')
    expect(comboOf(press('k', 'KeyK', { ctrlKey: true }), false)).toBe('Mod+KeyK')
    expect(comboOf(press('k', 'KeyK', { ctrlKey: true }), true)).toBe('Ctrl+KeyK')
    expect(comboOf(press('k', 'KeyK', { metaKey: true }), false)).toBeNull()
  })
  it('keeps the modifier order and the layout letter', () => {
    expect(comboOf(press('M', 'KeyM', { metaKey: true, shiftKey: true }), true)).toBe(
      'Mod+Shift+KeyM'
    )
    // Dvorak: the key labelled K sits where QWERTY has V.
    expect(comboOf(press('k', 'KeyV', { metaKey: true }), true)).toBe('Mod+KeyK')
    // ⌥ changes the character: the position decides.
    expect(comboOf(press('µ', 'KeyM', { altKey: true }), true)).toBe('Alt+KeyM')
    expect(comboOf(press('!', 'Digit1', { shiftKey: true }), true)).toBe('Shift+Digit1')
  })
  it('ignores a modifier on its own', () => {
    expect(comboOf(press('Shift', 'ShiftLeft', { shiftKey: true }), true)).toBeNull()
    expect(comboOf(press('Meta', 'MetaLeft', { metaKey: true }), true)).toBeNull()
  })
})

describe('keybinds', () => {
  it('resolves defaults, rebinds and unbinds', () => {
    const b = resolveKeybinds({ sidebar: null, switcher: 'Mod+KeyP' })
    expect(b.sidebar).toBeNull()
    expect(b.switcher).toBe('Mod+KeyP')
    expect(b.back).toBe('Mod+BracketLeft')
    expect(b.pushToTalk).toBeNull()
  })
  it('finds conflicts and reserved keys', () => {
    const b = resolveKeybinds({ sidebar: 'Mod+KeyK' })
    expect(actionsFor('Mod+KeyK', b)).toEqual(['switcher', 'sidebar'])
    expect(reservedBy('Mod+Digit3')).toMatch(/pinned tab/)
    expect(reservedBy('ArrowUp')).toMatch(/last message/)
    expect(reservedBy('Mod+KeyK')).toBeNull()
  })
  it('formats per platform', () => {
    expect(formatCombo('Mod+Shift+KeyM', true)).toBe('⌘⇧M')
    expect(formatCombo('Mod+Shift+KeyM', false)).toBe('Ctrl+Shift+M')
    expect(formatCombo('Mod+BracketLeft', true)).toBe('⌘[')
    expect(formatCombo('Backquote', false)).toBe('`')
  })
  it('makes accelerators only for keys that do not type', () => {
    expect(toAccelerator('Mod+Shift+KeyM')).toBe('CommandOrControl+Shift+M')
    expect(toAccelerator('Ctrl+Alt+Digit5')).toBe('Control+Alt+5')
    expect(toAccelerator('Mod+ArrowUp')).toBe('CommandOrControl+Up')
    expect(toAccelerator('F13')).toBe('F13')
    expect(toAccelerator('Backquote')).toBe('`')
    expect(toAccelerator('Shift+KeyM')).toBe('Shift+M')
    expect(toAccelerator('Mod+IntlRo')).toBeNull()
  })
})
