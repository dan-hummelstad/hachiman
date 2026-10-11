import { describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOM_GRADIENT, type CustomGradient } from './guild-tint'
import {
  addedStop,
  dialAngle,
  nudgeStop,
  pickStop,
  sliderKey,
  stopAt,
  stopOffset,
  withoutStop
} from './gradient-pad'

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

describe('pickStop', () => {
  const stops = [
    { h: 0, s: 50 },
    { h: 180, s: 100 }
  ]

  it('gives a tapped stop back, and a grab that puts it back where it was', () => {
    const o = stopOffset(stops[1], 100)
    const press = { x: o.x + 10, y: o.y - 5 }
    const { index, hit, grab } = pickStop(stops, press.x, press.y, 100, 24, 0)
    expect(index).toBe(1)
    expect(hit).toBe(true)
    expect(stopAt(press.x + grab.x, press.y + grab.y, 100)).toEqual(stops[1])
  })

  it('takes the nearest stop in reach', () => {
    expect(pickStop(stops, 40, 0, 100, 24, 1).index).toBe(0)
  })

  it('falls back to the selected stop with a zero grab off any stop', () => {
    expect(pickStop(stops, 0, 80, 100, 24, 1)).toEqual({
      index: 1,
      hit: false,
      grab: { x: 0, y: 0 }
    })
  })

  it('honours the reach', () => {
    expect(pickStop(stops, 70, 0, 100, 18, 1).index).toBe(1)
    expect(pickStop(stops, 70, 0, 100, 24, 1).index).toBe(0)
  })
})

describe('addedStop / withoutStop', () => {
  const two: CustomGradient = {
    ...DEFAULT_CUSTOM_GRADIENT,
    stops: [
      { h: 300, s: 40 },
      { h: 10, s: 90 }
    ]
  }

  it('adds a stop 120° on from the selected one, up to the limit', () => {
    const three = addedStop(two, 0)
    expect(three?.stops).toEqual([...two.stops, { h: 60, s: 40 }])
    expect(three && addedStop(three, 0)).toBeNull()
  })

  it('removes the selected stop but never the last one', () => {
    expect(withoutStop(two, 0)?.stops).toEqual([{ h: 10, s: 90 }])
    expect(withoutStop({ ...two, stops: [two.stops[0]] }, 0)).toBeNull()
  })
})
