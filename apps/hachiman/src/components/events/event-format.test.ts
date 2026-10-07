import { describe, expect, it } from 'vitest'
import type { GuildEventWithMe } from '@hachiman/client'
import { shortEventWhen } from './event-format'

/** Wednesday 7 October 2026, 15:00 local time. */
const NOW = new Date(2026, 9, 7, 15, 0).getTime()

const ev = (start: Date, end: Date | null = null): GuildEventWithMe => ({
  id: 'ev',
  guildId: 'g',
  channelId: null,
  title: 'Scrims',
  startsAt: start.toISOString(),
  endsAt: end?.toISOString() ?? null,
  createdBy: null,
  createdAt: new Date(NOW).toISOString(),
  rsvpCount: 0,
  me: false
})

const when = (start: Date, end: Date | null = null): string =>
  shortEventWhen(ev(start, end), NOW, 'en-GB')

describe('shortEventWhen', () => {
  it('shows "Now" while the event is ongoing', () => {
    expect(when(new Date(2026, 9, 7, 14, 30))).toBe('Now')
    expect(when(new Date(2026, 9, 7, 12, 0), new Date(2026, 9, 7, 18, 0))).toBe('Now')
  })

  it('names today and tomorrow', () => {
    expect(when(new Date(2026, 9, 7, 21, 0))).toBe('Today 21:00')
    expect(when(new Date(2026, 9, 8, 9, 5))).toBe('Tomorrow 09:05')
  })

  it('uses the weekday within the week', () => {
    expect(when(new Date(2026, 9, 9, 21, 0))).toBe('Fri 21:00')
    expect(when(new Date(2026, 9, 13, 21, 0))).toBe('Tue 21:00')
  })

  it('uses weekday and date a week or more ahead', () => {
    expect(when(new Date(2026, 9, 14, 21, 0))).toBe('Wed 14 21:00')
  })

  it('shows a midnight start as a date without time', () => {
    expect(when(new Date(2026, 9, 14))).toBe('Wed 14')
    expect(when(new Date(2026, 9, 10))).toBe('Sat 10')
    expect(when(new Date(2026, 9, 8))).toBe('Tomorrow')
  })
})
