import { expect, it } from 'vitest'
import { cornerPoint, snapCorner } from './popout-snap'

const size = { w: 320, h: 200 }
const viewport = { w: 1440, h: 900 }

it('a gentle release snaps to the nearest corner', () => {
  expect(snapCorner(100, 100, 0, 0, size, viewport)).toBe('tl')
  expect(snapCorner(1000, 600, 0, 0, size, viewport)).toBe('br')
})

it('a throw carries the popout to the corner it was flung at', () => {
  // Dropped top left of centre, but flung right and down.
  expect(snapCorner(400, 200, 3, 2, size, viewport)).toBe('br')
  expect(snapCorner(900, 500, -3, 0, size, viewport)).toBe('bl')
})

it('parks inside the insets', () => {
  const inset = { top: 60, right: 16, bottom: 16, left: 296 }
  expect(cornerPoint('tl', size, viewport, inset)).toEqual({ x: 296, y: 60 })
  expect(cornerPoint('br', size, viewport, inset)).toEqual({ x: 1104, y: 684 })
})
