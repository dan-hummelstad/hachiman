import { describe, expect, it } from 'vitest'
import { FALLBACK_HUES, dominantHue, fallbackHue, rgbToHsl, tintColors } from './guild-tint'

/** RGBA pixels: `count` copies of each colour. */
function pixels(
  ...parts: [rgb: [number, number, number], count: number, alpha?: number][]
): number[] {
  const out: number[] = []
  for (const [[r, g, b], count, a = 255] of parts)
    for (let i = 0; i < count; i++) out.push(r, g, b, a)
  return out
}

const near = (actual: number | null, expected: number, tolerance = 6): void => {
  expect(actual).not.toBeNull()
  const d = Math.abs((((actual as number) - expected + 540) % 360) - 180)
  expect(d).toBeLessThanOrEqual(tolerance)
}

describe('rgbToHsl', () => {
  it('gives the hue of the primaries', () => {
    expect(rgbToHsl(255, 0, 0)[0]).toBe(0)
    expect(rgbToHsl(0, 255, 0)[0]).toBe(120)
    expect(rgbToHsl(0, 0, 255)[0]).toBe(240)
    expect(rgbToHsl(128, 128, 128)[1]).toBe(0)
  })
})

describe('dominantHue', () => {
  it('picks the violet of a violet icon on a dark ground (Night Owls)', () => {
    const icon = pixels([[20, 22, 40], 500], [[123, 108, 255], 300], [[240, 180, 41], 40])
    near(dominantHue(icon), rgbToHsl(123, 108, 255)[0])
  })

  it('ignores the grey ground of a teal icon on white (Lattice Labs)', () => {
    const icon = pixels([[233, 236, 240], 600], [[47, 158, 143], 160], [[201, 138, 11], 40])
    near(dominantHue(icon), rgbToHsl(47, 158, 143)[0])
  })

  it('picks orange over a smaller blue area and skips transparent pixels (Dog-ear Club)', () => {
    const icon = pixels([[245, 130, 32], 200], [[60, 120, 220], 80], [[200, 0, 200], 900, 0])
    near(dominantHue(icon), rgbToHsl(245, 130, 32)[0])
  })

  it('returns null for an icon with no saturated pixel', () => {
    expect(
      dominantHue(pixels([[0, 0, 0], 10], [[255, 255, 255], 10], [[120, 120, 120], 10]))
    ).toBeNull()
    expect(dominantHue([])).toBeNull()
  })

  it('averages across the 0° wrap', () => {
    near(dominantHue(pixels([[255, 0, 10], 50], [[255, 10, 0], 50])), 0)
  })
})

describe('fallbackHue', () => {
  it('is stable and from the feature palette', () => {
    const hue = fallbackHue('g-night-owls')
    expect(fallbackHue('g-night-owls')).toBe(hue)
    expect(FALLBACK_HUES).toContain(hue)
  })

  it('spreads ids over the palette', () => {
    const seen = new Set(Array.from({ length: 64 }, (_, i) => fallbackHue(`guild-${i}`)))
    expect(seen.size).toBeGreaterThan(4)
  })
})

describe('tintColors', () => {
  it('keeps the lightness fixed per theme', () => {
    expect(tintColors(10)).toEqual({ light: 'hsl(10 45% 91%)', dark: 'hsl(10 42% 17%)' })
  })
})
