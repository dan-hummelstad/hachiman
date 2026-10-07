import { describe, expect, it } from 'vitest'
import { formatClock, formatExpiry, relativeTime } from './time-format'

const now = Date.parse('2026-10-07T12:00:00Z')

describe('relativeTime', () => {
  it('says just now within a minute', () => {
    expect(relativeTime('2026-10-07T11:59:30Z', now)).toBe('just now')
    expect(relativeTime('2026-10-07T12:00:30Z', now)).toBe('just now')
  })
  it('uses the largest unit, past and future', () => {
    expect(relativeTime('2026-10-07T11:55:00Z', now)).toMatch(/5/)
    expect(relativeTime('2026-10-07T09:00:00Z', now)).toMatch(/3/)
    expect(relativeTime('2026-10-07T15:00:00Z', now)).toMatch(/in .*3|3.*from/)
  })
})

describe('formatExpiry', () => {
  it('says Never, Expired, or the time left', () => {
    expect(formatExpiry(null, now)).toBe('Never')
    expect(formatExpiry('2026-10-07T11:00:00Z', now)).toBe('Expired')
    expect(formatExpiry('2026-10-13T12:00:00Z', now)).toMatch(/6/)
    expect(formatExpiry('2026-10-07T12:00:20Z', now)).toMatch(/20/)
  })
})

describe('formatClock', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatClock(-5)).toBe('0:00')
    expect(formatClock(4_700)).toBe('0:04')
    expect(formatClock(65_000)).toBe('1:05')
    expect(formatClock(750_000)).toBe('12:30')
    expect(formatClock((1 * 3600 + 24 * 60 + 7) * 1000)).toBe('1:24:07')
    expect(formatClock(Number.NaN)).toBe('0:00')
    expect(formatClock(Infinity)).toBe('0:00')
  })
})
