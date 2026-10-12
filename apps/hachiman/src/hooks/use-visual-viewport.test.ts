import { expect, it } from 'vitest'
import { KEYBOARD_MIN_INSET, viewportMetrics } from './use-visual-viewport'

it('has no inset with no keyboard', () => {
  expect(viewportMetrics(852, { height: 852, offsetTop: 0, scale: 1 })).toEqual({
    appHeight: 852,
    kb: 0
  })
})

it('measures the keyboard under the visible area', () => {
  const m = viewportMetrics(852, { height: 516, offsetTop: 0, scale: 1 })
  expect(m).toEqual({ appHeight: 516, kb: 336 })
  expect(m!.kb).toBeGreaterThan(KEYBOARD_MIN_INSET)
})

it('ignores the offset of a visual viewport that the field focus scrolled', () => {
  expect(viewportMetrics(852, { height: 516, offsetTop: 100, scale: 1 })?.kb).toBe(336)
})

it('never gives a negative inset', () => {
  expect(viewportMetrics(800, { height: 812, offsetTop: 0, scale: 1 })?.kb).toBe(0)
})

it('ignores a pinch-zoomed viewport', () => {
  expect(viewportMetrics(852, { height: 426, offsetTop: 200, scale: 2 })).toBeNull()
})
