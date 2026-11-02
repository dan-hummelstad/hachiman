import { describe, expect, it } from 'vitest'
import { deriveTheme, themeCss, type ThemeRecipe, type ThemeTokens } from './theme-engine'
import { THEME_PRESETS, findTheme } from './theme-presets'

const midnight = findTheme('midnight', [])!
const paper = findTheme('paper', [])!
const unpinned = (r: ThemeRecipe): ThemeRecipe => ({ ...r, pins: undefined })

/** Rough OKLab lightness from sRGB hex, enough to compare two greys. */
function lightness(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16)
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  const l = Math.cbrt(0.4122214708 * lin[0] + 0.5363325363 * lin[1] + 0.0514459929 * lin[2])
  const m = Math.cbrt(0.2119034982 * lin[0] + 0.6806995451 * lin[1] + 0.1073969566 * lin[2])
  const s = Math.cbrt(0.0883024619 * lin[0] + 0.2817188376 * lin[1] + 0.6299787005 * lin[2])
  return 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
}

describe('theme engine', () => {
  it('reproduces the designed presets', () => {
    const m = deriveTheme(midnight)
    expect(m.window).toBe('#0B0B0C')
    expect(m.rail).toBe('#121214')
    expect(m.sheet).toBe('#171719')
    expect(m.raised).toBe('#202023')
    expect(m.sunken).toBe('#0E0E10')
    expect(m.line).toBe('#242427')
    expect(m.lineStrong).toBe('#34343A')
    expect(m.text).toBe('#F3F2EF')
    expect(m.text2).toBe('#A6A5A0')
    expect(m.text3).toBe('#74736F')
    expect(m.text4).toBe('#4C4B48')
    expect(m.accent).toBe('#6C91D0')
    expect(m.you).toBe('#E8553C')
    expect(m.live).toBe('#2ED3C0')
    const p = deriveTheme(paper)
    expect(p.you).toBe('#CE4228')
    expect(p.liveText).toBe('#0A7567')
    expect(p.sheet).toBe('#FFFFFF')
  })

  it.each([midnight, paper])(
    'derives $id within tolerance of the pinned ramp without pins',
    (recipe) => {
      const pinned = deriveTheme(recipe)
      const derived = deriveTheme(unpinned(recipe))
      for (const k of [
        'rail',
        'sheet',
        'raised',
        'sunken',
        'line',
        'lineStrong',
        'text',
        'text2',
        'text3',
        'text4'
      ] as const) {
        expect(Math.abs(lightness(derived[k]) - lightness(pinned[k]))).toBeLessThan(0.012)
      }
    }
  )

  it('scales the surface steps with separation and leaves the text alone', () => {
    const one = deriveTheme({ ...unpinned(midnight), separation: 1 })
    const two = deriveTheme({ ...unpinned(midnight), separation: 2 })
    const step = (t: ThemeTokens): number => lightness(t.rail) - lightness(t.window)
    expect(step(two) / step(one)).toBeGreaterThan(1.8)
    expect(step(two) / step(one)).toBeLessThan(2.2)
    expect(two.text).toBe(one.text)
    expect(two.text3).toBe(one.text3)
  })

  it('keeps you and live fixed per ground', () => {
    const a = deriveTheme({ ...midnight, accent: '#CD9B70', base: '#060606', pins: undefined })
    const b = deriveTheme(midnight)
    for (const k of ['you', 'youText', 'live', 'liveText', 'liveLine', 'onLive'] as const)
      expect(a[k]).toBe(b[k])
    expect(deriveTheme(paper).you).not.toBe(b.you)
  })

  it('emits css for both grounds', () => {
    const css = themeCss(deriveTheme(midnight), deriveTheme(paper))
    expect(css).toContain(':root.dark')
    expect(css).toContain(':root.light')
    expect(css).toContain('--here:')
  })

  it('ships five presets with unique ids', () => {
    expect(new Set(THEME_PRESETS.map((t) => t.id)).size).toBe(5)
  })
})
