import { describe, expect, it } from 'vitest'
import { validateEventForm, type EventForm } from './event-form'

const NOW = new Date(2026, 9, 7, 15, 0).getTime()

const form = (patch: Partial<EventForm> = {}): EventForm => ({
  title: 'Scrims',
  startDate: '2026-10-08',
  startTime: '21:00',
  endDate: '',
  endTime: '',
  channelId: '',
  ...patch
})

describe('validateEventForm', () => {
  it('accepts a future start and trims the title', () => {
    const r = validateEventForm(form({ title: '  Scrims ', channelId: 'c1' }), NOW, null)
    expect(r).toEqual({
      ok: true,
      body: {
        title: 'Scrims',
        startsAt: new Date(2026, 9, 8, 21, 0).toISOString(),
        endsAt: null,
        channelId: 'c1'
      }
    })
  })

  it('rejects an empty or long title', () => {
    expect(validateEventForm(form({ title: '  ' }), NOW, null).ok).toBe(false)
    expect(validateEventForm(form({ title: 'x'.repeat(101) }), NOW, null).ok).toBe(false)
  })

  it('rejects a past start on create, keeps an unchanged past start on edit', () => {
    const past = form({ startDate: '2026-10-07', startTime: '14:00' })
    expect(validateEventForm(past, NOW, null).ok).toBe(false)
    const existing = { startsAt: new Date(2026, 9, 7, 14, 0).toISOString() }
    expect(validateEventForm(past, NOW, existing).ok).toBe(true)
  })

  it('needs the end after the start, and an end time alone takes the start date', () => {
    expect(validateEventForm(form({ endTime: '20:00' }), NOW, null).ok).toBe(false)
    const r = validateEventForm(form({ endTime: '23:00' }), NOW, null)
    expect(r.ok && r.body.endsAt).toBe(new Date(2026, 9, 8, 23, 0).toISOString())
    expect(validateEventForm(form({ endDate: '2026-10-09' }), NOW, null).ok).toBe(false)
  })
})
