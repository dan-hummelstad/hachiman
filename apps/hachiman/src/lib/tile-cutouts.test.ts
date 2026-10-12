import { describe, expect, it } from 'vitest'
import {
  RING,
  cutMask,
  pillHoles,
  shiftHoles,
  stackHoles,
  tileMark,
  type Hole
} from '@/lib/tile-cutouts'

const none = { mentions: 0, unread: false }
const dist = (a: Hole, x: number, y: number): number => Math.hypot(a[0] - x, a[1] - y)

describe('cutMask', () => {
  it('is none without holes', () => {
    expect(cutMask([])).toBe('none')
  })

  it('is one soft-edged radial gradient a hole, comma separated', () => {
    expect(
      cutMask([
        [24, 24, 6],
        [1.5, 2, 9.5]
      ])
    ).toBe(
      'radial-gradient(circle at 24px 24px, #0000 6px, #000 6.5px), ' +
        'radial-gradient(circle at 1.5px 2px, #0000 9.5px, #000 10px)'
    )
  })
})

describe('shiftHoles', () => {
  it('moves holes into the box of an icon at (x, y)', () => {
    expect(shiftHoles([[30, 1.5, 9.5]], 9, 9)).toEqual([[21, -7.5, 9.5]])
  })
})

describe('pillHoles', () => {
  it('is one circle for a round pill, its radius grown by the ring', () => {
    expect(pillHoles(21, 36, 1.5)).toEqual([[28.5, 1.5, 7.5 + RING]])
  })

  it('spaces circles at most 3 px apart from cap to cap', () => {
    const holes = pillHoles(12, 36, 1.5)
    expect(holes[0]).toEqual([19.5, 1.5, 9.5])
    expect(holes[holes.length - 1]).toEqual([28.5, 1.5, 9.5])
    for (let i = 1; i < holes.length; i++) {
      expect(holes[i][0] - holes[i - 1][0]).toBeLessThanOrEqual(3)
    }
  })
})

describe('tileMark', () => {
  it('has nothing to cut without a mark', () => {
    expect(tileMark(none, 28)).toEqual({ className: '', holes: [] })
    expect(tileMark({ mentions: 0, unread: true }, 28, { dot: false }).holes).toEqual([])
  })

  it('cuts the unread dot at the top-right corner, 2 px wider', () => {
    const { className, holes } = tileMark({ mentions: 0, unread: true }, 28)
    expect(className).toContain('mobile:ring-0')
    expect(holes).toEqual([[26.5, 1.5, 3.5 + RING]])
  })

  it('fixes the pill width by label length and cuts the whole pill', () => {
    const one = tileMark({ mentions: 3, unread: true }, 28)
    expect(one.className).toContain('mobile:w-[15px]')
    // -top-1.5 -right-2: the pill's right edge at 36, its centre line at 1.5.
    expect(one.holes).toEqual([[28.5, 1.5, 9.5]])

    const many = tileMark({ mentions: 120, unread: true }, 28)
    expect(many.className).toContain('mobile:w-6')
    expect(many.holes[0][0]).toBe(36 - 24 + 7.5)
    expect(many.holes[many.holes.length - 1][0]).toBe(28.5)
  })
})

describe('stackHoles', () => {
  it('cuts nothing out of a lone icon or the front icon', () => {
    expect(stackHoles(1, 0, [])).toEqual([])
    expect(stackHoles(3, 2, [])).toEqual([])
  })

  it('cuts the icons in front out of the ones behind, in the 18 px icon', () => {
    // Two: the front icon (14, 10) has its centre at (24, 20); the back icon starts at (1, 1).
    expect(stackHoles(2, 0, [])).toEqual([[23, 19, 10]])
    // Three: the back icon loses both, the middle one the front one.
    expect(stackHoles(3, 0, [])).toEqual([
      [23, 9, 10],
      [16, 19, 10]
    ])
    expect(stackHoles(3, 1, [])).toEqual([[2, 19, 10]])
  })

  it('adds the badge holes, moved from the stack box', () => {
    const [hole] = stackHoles(3, 1, [[30.5, 1.5, 9.5]]).slice(-1)
    expect(dist(hole, 30.5 - 15, 1.5 - 1)).toBe(0)
  })
})
