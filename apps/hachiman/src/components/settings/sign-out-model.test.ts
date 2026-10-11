import { describe, expect, it } from 'vitest'
import type { DeviceSummary } from '@hachiman/crypto'
import { joinNames, needsAck, otherDeviceNames, signOutCase } from './sign-out-model'

const device = (over: Partial<DeviceSummary>): DeviceSummary => ({
  id: 'd',
  name: 'Device',
  platform: 'browser',
  status: 'active',
  current: false,
  primary: false,
  lastSeenAt: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over
})

describe('signOutCase', () => {
  it('lets the recovery key bring the history back, with or without other devices', () => {
    expect(signOutCase(true, null)).toBe('recovery')
    expect(signOutCase(true, [])).toBe('recovery')
    expect(signOutCase(true, null, true)).toBe('recovery')
  })

  it('without a recovery key, depends on the other devices', () => {
    expect(signOutCase(false, ['Desktop'])).toBe('devices')
    expect(signOutCase(false, [])).toBe('lost')
    expect(signOutCase(false, null)).toBe('loading')
    expect(signOutCase(false, null, true)).toBe('unknown')
  })

  it('asks for a tick unless another device brings the history back', () => {
    expect(needsAck('recovery')).toBe(true)
    expect(needsAck('lost')).toBe(true)
    expect(needsAck('unknown')).toBe(true)
    expect(needsAck('devices')).toBe(false)
    expect(needsAck('loading')).toBe(false)
  })
})

describe('otherDeviceNames', () => {
  it('keeps the active devices other than this one', () => {
    const names = otherDeviceNames([
      device({ name: 'This iPhone', current: true }),
      device({ name: 'Desktop' }),
      device({ name: 'Old laptop', status: 'revoked' }),
      device({ name: 'New tablet', status: 'pending' }),
      device({ name: 'Firefox on Windows' })
    ])
    expect(names).toEqual(['Desktop', 'Firefox on Windows'])
  })
})

describe('joinNames', () => {
  it('joins up to two names and counts the rest', () => {
    expect(joinNames([])).toBe('')
    expect(joinNames(['A'])).toBe('A')
    expect(joinNames(['A', 'B'])).toBe('A and B')
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and 1 more')
    expect(joinNames(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more')
    expect(joinNames(['A', 'B', 'C'], 3)).toBe('A, B and C')
  })
})
