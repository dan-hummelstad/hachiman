import { describe, expect, it } from 'vitest'
import {
  canHide,
  initialSidebar,
  inHotZone,
  sidebarAfter,
  startsHidden
} from '@/lib/sidebar-reveal'

describe('initialSidebar', () => {
  it('tucks an undocked or narrow sidebar', () => {
    expect(initialSidebar('docked', 1400)).toBe('docked')
    expect(initialSidebar('undocked', 1400)).toBe('tucked')
    expect(initialSidebar('docked', 900)).toBe('tucked')
  })
})

describe('sidebarAfter', () => {
  it('reveals and tucks only a hidden sidebar', () => {
    expect(sidebarAfter('tucked', 'reveal')).toBe('revealed')
    expect(sidebarAfter('docked', 'reveal')).toBe('docked')
    expect(sidebarAfter('revealed', 'tuck')).toBe('tucked')
    expect(sidebarAfter('docked', 'tuck')).toBe('docked')
  })
  it('docks a tucked or revealed sidebar and tucks a docked one', () => {
    expect(sidebarAfter('docked', 'toggleDock')).toBe('tucked')
    expect(sidebarAfter('tucked', 'toggleDock')).toBe('docked')
    expect(sidebarAfter('revealed', 'toggleDock')).toBe('docked')
  })
})

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
