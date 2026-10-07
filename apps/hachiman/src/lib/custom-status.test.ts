import { describe, expect, it } from 'vitest'
import { clearAfterToExpiresAt } from './custom-status'

// Local time, so the midnight cases hold in every time zone. 7 Oct 2026 is a Wednesday.
const wed = new Date(2026, 9, 7, 15, 30)

describe('clearAfterToExpiresAt', () => {
  it('returns null for never', () => {
    expect(clearAfterToExpiresAt('never', wed)).toBeNull()
  })

  it('adds 1 or 4 hours', () => {
    expect(clearAfterToExpiresAt('1h', wed)).toBe(new Date(2026, 9, 7, 16, 30).toISOString())
    expect(clearAfterToExpiresAt('4h', wed)).toBe(new Date(2026, 9, 7, 19, 30).toISOString())
  })

  it('ends today at the next local midnight', () => {
    expect(clearAfterToExpiresAt('today', wed)).toBe(new Date(2026, 9, 8).toISOString())
  })

  it('ends this week at the start of next Monday', () => {
    expect(clearAfterToExpiresAt('week', wed)).toBe(new Date(2026, 9, 12).toISOString())
    const sunday = new Date(2026, 9, 11, 23, 0)
    expect(clearAfterToExpiresAt('week', sunday)).toBe(new Date(2026, 9, 12).toISOString())
    const monday = new Date(2026, 9, 12, 0, 1)
    expect(clearAfterToExpiresAt('week', monday)).toBe(new Date(2026, 9, 19).toISOString())
  })
})
