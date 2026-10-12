import { describe, expect, it } from 'vitest'
import {
  FALLBACK_HUES,
  customWallpaper,
  customWindowColor,
  dominantHue,
  fallbackHue,
  isCustomGradient,
  rgbToHsl,
  tintColors
} from './guild-tint'

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
  it('washes a fixed-lightness hue over the Arc base of each theme', () => {
    expect(tintColors(10)).toEqual({
      light: 'color-mix(in oklab, hsl(10 45% 91%) 30%, #e4e0fe)',
      dark: 'color-mix(in oklab, hsl(10 42% 17%) 30%, #201c46)'
    })
  })
})

describe('customWallpaper', () => {
  it('washes each stop over the window surface at the given angle', () => {
    const g = {
      stops: [
        { h: 0, s: 100 },
        { h: 240, s: 50 }
      ],
      lightness: 60,
      angle: 45
    }
    expect(customWallpaper(g)).toBe(
      'linear-gradient(45deg, color-mix(in oklab, hsl(0 100% 60%) 30%, var(--surface-window)), ' +
        'color-mix(in oklab, hsl(240 50% 60%) 30%, var(--surface-window)))'
    )
  })

  it('repeats a single stop', () => {
    const one = customWallpaper({ stops: [{ h: 10, s: 20 }], lightness: 50, angle: 0 })
    expect(one.match(/hsl\(10 20% 50%\)/g)).toHaveLength(2)
  })
})

describe('customWindowColor', () => {
  it('is the first stop, washed as customWallpaper washes it', () => {
    const g = {
      stops: [
        { h: 0, s: 100 },
        { h: 240, s: 50 }
      ],
      lightness: 60,
      angle: 45
    }
    expect(customWindowColor(g)).toBe(
      'color-mix(in oklab, hsl(0 100% 60%) 30%, var(--surface-window))'
    )
    expect(customWallpaper(g)).toContain(customWindowColor(g))
  })

  it('falls back to the window surface with no stops', () => {
    expect(customWindowColor({ stops: [], lightness: 60, angle: 0 })).toBe('var(--surface-window)')
  })
})

describe('isCustomGradient', () => {
  it('accepts 1 to 3 stops and rejects older or broken shapes', () => {
    const stop = { h: 1, s: 2 }
    expect(isCustomGradient({ stops: [stop], lightness: 50, angle: 0 })).toBe(true)
    expect(isCustomGradient({ stops: [], lightness: 50, angle: 0 })).toBe(false)
    expect(isCustomGradient({ stops: [stop, stop, stop, stop], lightness: 50, angle: 0 })).toBe(
      false
    )
    expect(isCustomGradient({ from: '#000000', to: '#ffffff', angle: 90 })).toBe(false)
    expect(isCustomGradient(undefined)).toBe(false)
  })
})
