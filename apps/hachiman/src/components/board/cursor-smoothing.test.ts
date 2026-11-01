import { describe, expect, it } from 'vitest'
import { SmoothCursor, catmullRom } from './cursor-smoothing'

describe('SmoothCursor', () => {
  it('shows the first point at once, then glides to the next over the frame interval', () => {
    const c = new SmoothCursor()
    c.push({ x: 0, y: 0 }, 0)
    expect(c.at(0)).toEqual({ point: { x: 0, y: 0 }, moving: false })
    c.push({ x: 100, y: 0 }, 200)
    const mid = c.at(300)
    expect(mid.moving).toBe(true)
    expect(mid.point!.x).toBeGreaterThan(0)
    expect(mid.point!.x).toBeLessThan(100)
    expect(c.at(400)).toEqual({ point: { x: 100, y: 0 }, moving: false })
  })

  it('never moves backwards along a straight line', () => {
    const c = new SmoothCursor()
    c.push({ x: 0, y: 0 }, 0)
    for (let i = 1; i <= 4; i++) c.push({ x: i * 10, y: 0 }, i * 200)
    let prev = -1
    for (let t = 200; t <= 1400; t += 16) {
      const x = c.at(t).point!.x
      expect(x).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = x
    }
    expect(prev).toBe(40)
  })

  it('drops old segments when it falls behind, so the lag stays bounded', () => {
    const c = new SmoothCursor()
    c.push({ x: 0, y: 0 }, 0)
    for (let i = 1; i <= 10; i++) c.push({ x: i, y: 0 }, i * 200)
    // Three segments of 200 ms are left: it ends 600 ms after the last frame.
    expect(c.at(2000 + 600).point).toEqual({ x: 10, y: 0 })
  })
})

it('catmullRom passes through its middle points', () => {
  const p = [
    { x: 0, y: 0 },
    { x: 1, y: 2 },
    { x: 3, y: 1 },
    { x: 4, y: 4 }
  ] as const
  expect(catmullRom(...p, 0)).toEqual(p[1])
  expect(catmullRom(...p, 1)).toEqual(p[2])
})
