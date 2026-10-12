import { describe, expect, it } from 'vitest'
import { revealScrollLeft } from './chip-scroller'

describe('revealScrollLeft', () => {
  const view = { scrollLeft: 100, width: 300 }

  it('leaves a chip that shows whole', () => {
    expect(revealScrollLeft(view, { start: 120, end: 380 }, 16)).toBeNull()
    expect(revealScrollLeft(view, { start: 116, end: 384 }, 16)).toBeNull()
  })

  it('scrolls back to a chip cut at the start, inset clear of the edge', () => {
    expect(revealScrollLeft(view, { start: 110, end: 200 }, 16)).toBe(94)
    expect(revealScrollLeft(view, { start: 0, end: 80 })).toBe(0)
  })

  it('never scrolls before the start', () => {
    expect(revealScrollLeft(view, { start: 8, end: 80 }, 16)).toBe(0)
  })

  it('scrolls on to a chip cut at the end', () => {
    expect(revealScrollLeft(view, { start: 350, end: 450 }, 16)).toBe(166)
    expect(revealScrollLeft(view, { start: 500, end: 560 })).toBe(260)
  })

  it('shows a chip wider than the view from its start', () => {
    expect(revealScrollLeft(view, { start: 200, end: 600 }, 16)).toBe(184)
    expect(revealScrollLeft(view, { start: 50, end: 450 })).toBe(50)
  })
})
