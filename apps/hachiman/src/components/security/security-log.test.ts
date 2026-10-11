import { describe, expect, it } from 'vitest'
import type { DeviceSummary } from '@hachiman/crypto'
import { keyLogDay, keyLogRows } from './security-log'

const NOW = new Date(2026, 9, 11, 9, 39).getTime()

function device(over: Partial<DeviceSummary>): DeviceSummary {
  return {
    id: 'd',
    name: 'Hachiman Desktop',
    platform: 'electron',
    status: 'active',
    current: false,
    primary: false,
    lastSeenAt: null,
    createdAt: new Date(2026, 8, 12, 10).toISOString(),
    ...over
  } as DeviceSummary
}

describe('keyLogDay', () => {
  it('says Today for any time of the current day, and for a time in the future', () => {
    expect(keyLogDay(new Date(2026, 9, 11, 0, 5).toISOString(), NOW, 'en-GB')).toBe('Today')
    expect(keyLogDay(new Date(2026, 9, 11, 23, 50).toISOString(), NOW, 'en-GB')).toBe('Today')
    expect(keyLogDay(new Date(2026, 9, 14).toISOString(), NOW, 'en-GB')).toBe('Today')
  })

  it('gives the day and month this year, and adds the year before it', () => {
    expect(keyLogDay(new Date(2026, 9, 10, 23, 59).toISOString(), NOW, 'en-GB')).toBe('10 Oct')
    expect(keyLogDay(new Date(2026, 7, 2).toISOString(), NOW, 'en-GB')).toBe('2 Aug')
    expect(keyLogDay(new Date(2025, 7, 2).toISOString(), NOW, 'en-GB')).toBe('2 Aug 2025')
  })

  it('is empty for a broken time', () => {
    expect(keyLogDay('not a date', NOW, 'en-GB')).toBe('')
  })
})

describe('keyLogRows', () => {
  it('is empty while the devices load', () => {
    expect(keyLogRows(null, NOW)).toEqual([])
  })

  it('puts the newest device first and leaves the input alone', () => {
    const devices = [
      device({ id: 'a', createdAt: new Date(2026, 5, 2).toISOString() }),
      device({ id: 'c', createdAt: new Date(2026, 9, 11, 8).toISOString() }),
      device({ id: 'b', createdAt: new Date(2026, 6, 14).toISOString() })
    ]
    const rows = keyLogRows(devices, NOW, 'en-GB')
    expect(rows.map((r) => r.device.id)).toEqual(['c', 'b', 'a'])
    expect(rows.map((r) => r.day)).toEqual(['Today', '14 Jul', '2 Jun'])
    expect(devices.map((d) => d.id)).toEqual(['a', 'c', 'b'])
  })

  it('names this device, and other devices by name', () => {
    const [mine, other] = keyLogRows(
      [
        device({ id: 'm', current: true, createdAt: new Date(2026, 9, 1).toISOString() }),
        device({ id: 'o', name: "kestrel's iPhone", platform: 'ios' })
      ],
      NOW
    )
    expect(mine?.title).toBe('Added this device')
    expect(other?.title).toBe("Added kestrel's iPhone")
  })

  it('gives the kind of app, then the security key or the sign-out', () => {
    const rows = keyLogRows(
      [
        device({ id: '1', platform: 'browser', createdAt: '2026-10-04T10:00:00Z' }),
        device({ id: '2', primary: true, createdAt: '2026-10-03T10:00:00Z' }),
        device({
          id: '3',
          platform: 'ios',
          status: 'revoked',
          primary: true,
          createdAt: '2026-10-02T10:00:00Z'
        })
      ],
      NOW
    )
    expect(rows.map((r) => r.meta)).toEqual([
      'Browser',
      'Desktop app · has your security key',
      'iPhone app · signed out'
    ])
  })
})
