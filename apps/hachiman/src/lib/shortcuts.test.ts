import { describe, expect, it } from 'vitest'
import { matchShortcut, underModal } from '@/lib/shortcuts'

describe('matchShortcut', () => {
  it('maps the ⌘ keys', () => {
    expect(matchShortcut('[', true)).toEqual({ kind: 'back' })
    expect(matchShortcut(']', true)).toEqual({ kind: 'forward' })
    expect(matchShortcut('S', true)).toEqual({ kind: 'sidebar' })
    expect(matchShortcut('k', true)).toEqual({ kind: 'switcher' })
    expect(matchShortcut('1', true)).toEqual({ kind: 'tab', index: 0 })
    expect(matchShortcut('9', true)).toEqual({ kind: 'tab', index: 8 })
    expect(matchShortcut('0', true)).toBeNull()
    expect(matchShortcut('Enter', true)).toBeNull()
  })
  it('takes Esc only without ⌘, and nothing else without ⌘', () => {
    expect(matchShortcut('Escape', false)).toEqual({ kind: 'leaveSettings' })
    expect(matchShortcut('Escape', true)).toBeNull()
    expect(matchShortcut('s', false)).toBeNull()
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
