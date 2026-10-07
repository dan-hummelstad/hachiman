import { describe, expect, it } from 'vitest'
import { pageLinksOf, stripPageLinks } from './page-link-text'
import { reactionChips } from './reactions'
import { relativeTime } from './relative-time'
import { downsamplePeaks, formatDuration, WAVEFORM_FLOOR } from './waveform'

describe('reactionChips', () => {
  it('keeps the map order, counts users and marks mine', () => {
    const map = new Map<string, Set<string>>([
      ['🍿', new Set(['a', 'b'])],
      ['🎮', new Set(['me', 'a', 'c'])]
    ])
    expect(reactionChips(map, 'me')).toEqual([
      { emoji: '🍿', count: 2, mine: false },
      { emoji: '🎮', count: 3, mine: true }
    ])
  })

  it('drops emojis without users and marks nothing without a user', () => {
    const map = new Map<string, Set<string>>([
      ['👀', new Set()],
      ['🔥', new Set(['me'])]
    ])
    expect(reactionChips(map, undefined)).toEqual([{ emoji: '🔥', count: 1, mine: false }])
  })
})

describe('downsamplePeaks', () => {
  it('gives one normalised peak per bar over all channels', () => {
    const left = [0, 0.5, 0, -0.25, 0, 0, 0, 0.1]
    const right = [0, 0, 0, 0, -1, 0, 0, 0]
    expect(downsamplePeaks([left, right], 4)).toEqual([0.5, 0.25, 1, 0.1])
  })

  it('raises quiet bars to the floor', () => {
    const peaks = downsamplePeaks([[1, 0.01, 0, 0]], 4)
    expect(peaks).toEqual([1, WAVEFORM_FLOOR, WAVEFORM_FLOOR, WAVEFORM_FLOOR])
  })

  it('handles silence, empty input and fewer samples than bars', () => {
    expect(downsamplePeaks([[0, 0, 0]], 3)).toEqual([
      WAVEFORM_FLOOR,
      WAVEFORM_FLOOR,
      WAVEFORM_FLOOR
    ])
    expect(downsamplePeaks([], 2)).toEqual([WAVEFORM_FLOOR, WAVEFORM_FLOOR])
    const short = downsamplePeaks([[0.2, 0.4]], 48)
    expect(short).toHaveLength(48)
    expect(Math.max(...short)).toBe(1)
  })

  it('returns nothing for zero bars', () => {
    expect(downsamplePeaks([[1]], 0)).toEqual([])
  })
})

describe('formatDuration', () => {
  it('formats minutes and seconds', () => {
    expect(formatDuration(4.7)).toBe('0:04')
    expect(formatDuration(750)).toBe('12:30')
    expect(formatDuration(Number.NaN)).toBe('0:00')
    expect(formatDuration(Infinity)).toBe('0:00')
  })
})

describe('page links in text', () => {
  const a = '9e3a4d6c-7f5b-4a8c-9d0e-2f3a4b5c6d7e'
  const b = '7c1e2b4a-5d3f-4e6a-9b8c-0d1e2f3a4b5c'

  it('finds markdown and bare links once each', () => {
    const text = `see [Scrim playbook](hachiman:page/${a}) and hachiman:page/${b} and [again](hachiman:page/${a})`
    expect(pageLinksOf(text)).toEqual([a, b])
  })

  it('ignores ids that are not page ids', () => {
    expect(pageLinksOf('[x](hachiman:page/../etc)')).toEqual([])
  })

  it('strips the links from the shown text', () => {
    expect(stripPageLinks(`pinned it again [Scrim playbook](hachiman:page/${a})`)).toBe(
      'pinned it again'
    )
    expect(stripPageLinks(`hachiman:page/${a}`)).toBe('')
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-10-07T12:00:00Z')
  it('says just now under a minute', () => {
    expect(relativeTime('2026-10-07T11:59:30Z', now)).toBe('just now')
  })
  it('uses the largest unit', () => {
    expect(relativeTime('2026-10-07T11:55:00Z', now)).toMatch(/5/)
    expect(relativeTime('2026-10-07T09:00:00Z', now)).toMatch(/3/)
  })
})
