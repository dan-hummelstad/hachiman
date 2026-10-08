import { describe, expect, it } from 'vitest'
import { resolveKeybinds } from '@/lib/keybinds'
import { matchShortcut, underModal } from '@/lib/shortcuts'

const defaults = resolveKeybinds({})

describe('matchShortcut', () => {
  it('maps the default keys', () => {
    expect(matchShortcut('Mod+BracketLeft', defaults)).toEqual({ kind: 'back' })
    expect(matchShortcut('Mod+BracketRight', defaults)).toEqual({ kind: 'forward' })
    expect(matchShortcut('Mod+KeyS', defaults)).toEqual({ kind: 'sidebar' })
    expect(matchShortcut('Mod+KeyK', defaults)).toEqual({ kind: 'switcher' })
    expect(matchShortcut('Mod+Shift+KeyM', defaults)).toEqual({ kind: 'toggleMute' })
    expect(matchShortcut('Mod+Digit1', defaults)).toEqual({ kind: 'tab', index: 0 })
    expect(matchShortcut('Mod+Digit9', defaults)).toEqual({ kind: 'tab', index: 8 })
    expect(matchShortcut('Mod+Digit0', defaults)).toBeNull()
    expect(matchShortcut('Mod+Enter', defaults)).toBeNull()
    expect(matchShortcut(null, defaults)).toBeNull()
  })
  it('takes Esc only without modifiers', () => {
    expect(matchShortcut('Escape', defaults)).toEqual({ kind: 'leaveSettings' })
    expect(matchShortcut('Mod+Escape', defaults)).toBeNull()
    expect(matchShortcut('KeyS', defaults)).toBeNull()
  })
  it('follows a rebind and an unbind', () => {
    const binds = resolveKeybinds({ switcher: 'Mod+KeyP', sidebar: null, pushToTalk: 'Backquote' })
    expect(matchShortcut('Mod+KeyP', binds)).toEqual({ kind: 'switcher' })
    expect(matchShortcut('Mod+KeyK', binds)).toBeNull()
    expect(matchShortcut('Mod+KeyS', binds)).toBeNull()
    expect(matchShortcut('Backquote', binds)).toEqual({ kind: 'pushToTalk' })
  })
})

describe('underModal', () => {
  const at = (inside: boolean): EventTarget =>
    ({ closest: () => (inside ? {} : null) }) as unknown as EventTarget
  it('is true with an app dialog or inside a modal dialog', () => {
    expect(underModal(at(false), true)).toBe(true)
    expect(underModal(at(true), false)).toBe(true)
    expect(underModal(at(false), false)).toBe(false)
    expect(underModal(null, false)).toBe(false)
  })
})
