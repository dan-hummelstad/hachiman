import { describe, expect, it } from 'vitest'
import {
  calendarDaysAgo,
  dayStart,
  formatClock,
  formatDayMonth,
  formatDayMonthYear,
  formatExpiry,
  formatListTime,
  relativeTime
} from './time-format'

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

describe('formatListTime', () => {
  // Local times, so the calendar days do not depend on the time zone of the test run.
  const at = (d: number, h = 0, m = 0, month = 9, year = 2026): number =>
    new Date(year, month, d, h, m).getTime()
  const wed = at(7, 12) // Wednesday 7 Oct 2026, 12:00

  it('shows the 24 h clock today', () => {
    expect(formatListTime(at(7, 10, 53), wed, 'en-GB')).toBe('10:53')
    expect(formatListTime(at(7, 0, 5), wed, 'en-US')).toBe('00:05')
    expect(formatListTime(new Date(at(7, 9, 4)), wed, 'en-GB')).toBe('09:04')
  })
  it('counts a time in the future as today', () => {
    expect(formatListTime(at(8, 1, 0), wed, 'en-GB')).toBe('01:00')
  })
  it('shows the weekday within the last six days', () => {
    expect(formatListTime(at(6, 23, 59), wed, 'en-GB')).toBe('Tue')
    expect(formatListTime(at(5, 8), wed, 'en-GB')).toBe('Mon')
    expect(formatListTime(at(1, 8), wed, 'en-GB')).toBe('Thu')
  })
  it('shows the date from a week back, with the year when it differs', () => {
    expect(formatListTime(at(30, 23, 0, 8), wed, 'en-GB')).toMatch(/^30 Sep/)
    expect(formatListTime(at(30, 23, 0, 7), wed, 'en-GB')).toBe('30 Aug')
    expect(formatListTime(at(6, 8, 0, 9, 2025), wed, 'en-GB')).toBe('6 Oct 2025')
  })
})

describe('formatDayMonth', () => {
  it('gives no day for a missing or broken time', () => {
    expect(formatDayMonth(null)).toBeNull()
    expect(formatDayMonth('not a date')).toBeNull()
  })

  it('formats the day and month only', () => {
    const day = formatDayMonth('2026-10-02T12:00:00.000Z')
    expect(day).toMatch(/2/)
    expect(day).not.toMatch(/2026/)
  })
})

describe('dayStart and calendarDaysAgo', () => {
  const at = (d: number, h = 0, m = 0, month = 9): number =>
    new Date(2026, month, d, h, m).getTime()

  it('gives the local midnight of the day', () => {
    expect(dayStart(at(11, 23, 59))).toBe(at(11))
    expect(dayStart(at(11))).toBe(at(11))
  })

  it('counts calendar days, not 24 hour spans', () => {
    expect(calendarDaysAgo(at(11, 0, 5), at(11, 23))).toBe(0)
    expect(calendarDaysAgo(at(10, 23, 55), at(11, 0, 5))).toBe(1)
    expect(calendarDaysAgo(at(30, 12, 0, 8), at(2, 12))).toBe(2)
    expect(calendarDaysAgo(at(12, 1), at(11, 23))).toBe(-1)
  })
})

describe('formatDayMonthYear', () => {
  const now = new Date(2026, 9, 11, 12).getTime()

  it('leaves out the year of this year', () => {
    expect(formatDayMonthYear(new Date(2026, 9, 2).getTime(), now, 'en-GB')).toBe('2 Oct')
    expect(formatDayMonthYear(new Date(2026, 0, 1), now, 'en-GB')).toBe('1 Jan')
  })

  it('shows the year of another year', () => {
    expect(formatDayMonthYear(new Date(2025, 7, 2).getTime(), now, 'en-GB')).toBe('2 Aug 2025')
    expect(formatDayMonthYear(new Date(2027, 0, 3).getTime(), now, 'en-GB')).toBe('3 Jan 2027')
  })
})
