import { describe, expect, it } from 'vitest'
import { dialAngle, nudgeStop, sliderKey, stopAt, stopOffset } from './gradient-pad'

describe('stopAt / stopOffset', () => {
  it('maps the angle to the hue and the distance to the saturation', () => {
    expect(stopAt(50, 0, 100)).toEqual({ h: 0, s: 50 })
    expect(stopAt(0, 100, 100)).toEqual({ h: 90, s: 100 })
    expect(stopAt(-300, 0, 100)).toEqual({ h: 180, s: 100 })
    expect(stopAt(0, 0, 100).s).toBe(0)
  })

  it('round-trips', () => {
    const o = stopOffset({ h: 210, s: 40 }, 90)
    expect(stopAt(o.x, o.y, 90)).toEqual({ h: 210, s: 40 })
  })
})

describe('dialAngle', () => {
  it('is 0 up and turns clockwise', () => {
    expect(dialAngle(0, -10)).toBe(0)
    expect(dialAngle(10, 0)).toBe(90)
    expect(dialAngle(0, 10)).toBe(180)
    expect(dialAngle(-10, 0)).toBe(270)
  })
})

describe('keys', () => {
  it('nudges a stop and wraps the hue', () => {
    expect(nudgeStop({ h: 2, s: 50 }, 'ArrowLeft', false)).toEqual({ h: 357, s: 50 })
    expect(nudgeStop({ h: 0, s: 98 }, 'ArrowUp', false)).toEqual({ h: 0, s: 100 })
    expect(nudgeStop({ h: 0, s: 0 }, 'Enter', false)).toBeNull()
  })

  it('moves a slider value, clamped or wrapped', () => {
    expect(sliderKey(89, 'ArrowRight', 15, 90, 1)).toBe(90)
    expect(sliderKey(90, 'ArrowRight', 15, 90, 1)).toBe(90)
    expect(sliderKey(50, 'Home', 15, 90, 1)).toBe(15)
    expect(sliderKey(355, 'ArrowRight', 0, 360, 5, true)).toBe(0)
    expect(sliderKey(0, 'ArrowLeft', 0, 360, 5, true)).toBe(355)
    expect(sliderKey(0, 'x', 0, 360, 5)).toBeNull()
  })
})
