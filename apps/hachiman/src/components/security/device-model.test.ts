import { describe, expect, it, vi } from 'vitest'
import { activeText, addedDay, addedText, deviceMeta, lastActiveText } from './device-model'

// The rename calls the crypto Worker; the text helpers under test do not.
vi.mock('@/services/CryptoService', () => ({ cryptoService: {} }))

/** A local time on 11 Oct 2026. */
const at = (hours: number, minutes = 0, day = 11): number =>
  new Date(2026, 9, day, hours, minutes).getTime()
const iso = (ms: number): string => new Date(ms).toISOString()

const NOW = at(14, 30)

describe('activeText', () => {
  it('says "active now" within five minutes', () => {
    expect(activeText(iso(at(14, 27)), NOW)).toBe('active now')
  })

  it('says how long ago after that', () => {
    expect(activeText(iso(at(12, 30)), NOW)).toBe('active 2 hours ago')
  })
})

describe('deviceMeta', () => {
  it('gives the app and when the device was active', () => {
    expect(
      deviceMeta({ platform: 'electron', current: false, lastSeenAt: iso(at(12, 30)) }, NOW)
    ).toBe('Desktop app · active 2 hours ago')
  })

  it('marks this device active now, whatever the server saw', () => {
    expect(deviceMeta({ platform: 'ios', current: true, lastSeenAt: iso(at(9)) }, NOW)).toBe(
      'iPhone app · active now'
    )
    expect(deviceMeta({ platform: 'ios', current: true, lastSeenAt: null }, NOW)).toBe(
      'iPhone app · active now'
    )
  })

  it('gives only the app for a device that the server has not seen', () => {
    expect(deviceMeta({ platform: 'browser', current: false, lastSeenAt: null }, NOW)).toBe(
      'Browser'
    )
  })
})

describe('lastActiveText', () => {
  it('says "Now" for this device and a device seen in the last minutes', () => {
    expect(lastActiveText({ current: true, lastSeenAt: null }, NOW)).toBe('Now')
    expect(lastActiveText({ current: false, lastSeenAt: iso(at(14, 28)) }, NOW)).toBe('Now')
  })

  it('starts with a capital letter', () => {
    expect(lastActiveText({ current: false, lastSeenAt: iso(at(12, 30)) }, NOW)).toBe('2 hours ago')
    expect(lastActiveText({ current: false, lastSeenAt: iso(at(14, 30, 10)) }, NOW)).toBe(
      'Yesterday'
    )
  })

  it('is null for a device that the server has not seen, or a broken time', () => {
    expect(lastActiveText({ current: false, lastSeenAt: null }, NOW)).toBeNull()
    expect(lastActiveText({ current: false, lastSeenAt: 'never' }, NOW)).toBeNull()
  })
})

describe('addedDay and addedText', () => {
  it('names today and yesterday by their local calendar day', () => {
    expect(addedDay(iso(at(0, 5)), NOW)).toBe('today')
    expect(addedDay(iso(at(23, 55, 10)), NOW)).toBe('yesterday')
    expect(addedText(iso(at(9, 38)), NOW)).toMatch(/^Today, \S/)
    expect(addedText(iso(at(18, 2, 10)), NOW)).toMatch(/^Yesterday, \S/)
  })

  it('gives the date for an earlier day, with the year of another year', () => {
    const date = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })
    expect(addedDay(iso(at(9, 0, 2)), NOW)).toBe(date.format(at(9, 0, 2)))
    expect(addedText(iso(at(9, 0, 2)), NOW)).toBe(date.format(at(9, 0, 2)))
    const lastYear = new Date(2025, 9, 2, 9).getTime()
    expect(addedDay(iso(lastYear), NOW)).toMatch(/2025/)
  })

  it('counts a time in the future (clock skew) as today', () => {
    expect(addedDay(iso(at(9, 0, 12)), NOW)).toBe('today')
  })

  it('is null for a broken time', () => {
    expect(addedDay('soon', NOW)).toBeNull()
    expect(addedText('soon', NOW)).toBeNull()
  })
})
