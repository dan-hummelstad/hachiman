import { describe, expect, it } from 'vitest'
import { canHide, inHotZone, isTextField, startsHidden } from '@/lib/sidebar-reveal'

describe('canHide', () => {
  const none = { menuOpen: false, dragging: false, fieldFocused: false }
  it('hides only when nothing holds the sidebar', () => {
    expect(canHide(none)).toBe(true)
    expect(canHide({ ...none, menuOpen: true })).toBe(false)
    expect(canHide({ ...none, dragging: true })).toBe(false)
    expect(canHide({ ...none, fieldFocused: true })).toBe(false)
  })
})

describe('inHotZone', () => {
  it('is the left 8 px', () => {
    expect(inHotZone(0)).toBe(true)
    expect(inHotZone(7)).toBe(true)
    expect(inHotZone(8)).toBe(false)
    expect(inHotZone(-1)).toBe(false)
  })
})

describe('startsHidden', () => {
  it('follows the choice, and hides below 1100 px', () => {
    expect(startsHidden('docked', 1400)).toBe(false)
    expect(startsHidden('undocked', 1400)).toBe(true)
    expect(startsHidden('docked', 1099)).toBe(true)
    expect(startsHidden('docked', 1100)).toBe(false)
  })
})

describe('isTextField', () => {
  const el = (tagName: string, extra: Record<string, unknown> = {}): Element =>
    ({ tagName, ...extra }) as unknown as Element
  it('takes inputs, textareas and contenteditable', () => {
    expect(isTextField(null)).toBe(false)
    expect(isTextField(el('TEXTAREA'))).toBe(true)
    expect(isTextField(el('INPUT', { type: 'text' }))).toBe(true)
    expect(isTextField(el('INPUT', { type: 'checkbox' }))).toBe(false)
    expect(isTextField(el('DIV', { isContentEditable: true }))).toBe(true)
    expect(isTextField(el('BUTTON'))).toBe(false)
  })
})
