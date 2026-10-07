import { expect, it } from 'vitest'
import { visibleCustomStatus } from './use-custom-status'

const NOW = Date.parse('2026-10-07T12:00:00.000Z')

it('shows a status without an end', () => {
  const s = { text: 'Reading chapter 6', expiresAt: null }
  expect(visibleCustomStatus(s, NOW)).toBe(s)
})

it('hides a status from its expiry on', () => {
  const s = { text: '5am, watching the VOD', expiresAt: new Date(NOW + 1_000).toISOString() }
  expect(visibleCustomStatus(s, NOW)).toBe(s)
  expect(visibleCustomStatus(s, NOW + 1_000)).toBeNull()
  expect(visibleCustomStatus(undefined, NOW)).toBeNull()
})
