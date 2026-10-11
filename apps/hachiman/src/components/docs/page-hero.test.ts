import { describe, expect, it } from 'vitest'
import { coverHues, pageCover } from './page-hero'

const tint = { light: 'TINT-LIGHT', dark: 'TINT-DARK' }

describe('coverHues', () => {
  it('is the same for the same page', () => {
    expect(coverHues('p1')).toEqual(coverHues('p1'))
  })

  it('gives hues in 0–359, the glow 300° on from the far end', () => {
    for (const id of ['p1', 'p2', 'a-long-page-id', '']) {
      const { a, b } = coverHues(id)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(360)
      expect(b).toBe((a + 300) % 360)
    }
  })

  it('differs between pages', () => {
    const hues = new Set(['p1', 'p2', 'p3', 'p4', 'p5'].map((id) => coverHues(id).a))
    expect(hues.size).toBeGreaterThan(1)
  })
})

describe('pageCover', () => {
  it('starts at the guild tint of each theme', () => {
    const cover = pageCover('p1', tint)
    expect(cover.light).toContain('linear-gradient(100deg, TINT-LIGHT 0%')
    expect(cover.dark).toContain('linear-gradient(100deg, TINT-DARK 0%')
    expect(cover.light).not.toContain('TINT-DARK')
  })

  it('ends at the hue of the page and glows in the page violet', () => {
    const { a, b } = coverHues('p1')
    const cover = pageCover('p1', tint)
    expect(cover.dark).toContain(`hsl(${a} 50% 32%) 100%`)
    expect(cover.dark).toContain(`hsl(${b} 65% 50% / 0.4)`)
    expect(cover.dark).toContain('var(--feature-page)')
    expect(cover.light).toContain(`hsl(${a} 60% 80%) 100%`)
  })
})
