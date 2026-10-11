import { describe, expect, it } from 'vitest'
import { ACTIVATION_FRESH_MS, pickOpener } from './focus-opener'

describe('pickOpener', () => {
  it('takes a fresh activation over the focused element (WebKit does not focus a tapped button)', () => {
    expect(pickOpener({ focused: 'old', activated: 'tapped', activatedAgo: 20 })).toBe('tapped')
  })

  it('takes the focused element when the activation is old (a keyboard shortcut)', () => {
    expect(
      pickOpener({ focused: 'row', activated: 'tapped', activatedAgo: ACTIVATION_FRESH_MS + 1 })
    ).toBe('row')
  })

  it('falls back to an old activation when nothing has the focus', () => {
    expect(pickOpener({ focused: null, activated: 'tapped', activatedAgo: 5000 })).toBe('tapped')
  })

  it('has no opener when there is neither', () => {
    expect(pickOpener({ focused: null, activated: null, activatedAgo: 0 })).toBeNull()
  })
})
