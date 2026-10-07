import { expect, it } from 'vitest'
import type { GuildEventWithMe } from '@hachiman/client'
import { NEXT_EVENT_HORIZON_MS, OPEN_EVENT_MS, nextEvent } from './eventsStore'

const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const H = 3_600_000
const ev = (
  id: string,
  startOffset: number,
  endOffset: number | null = null
): GuildEventWithMe => ({
  id,
  guildId: 'g',
  channelId: null,
  title: id,
  startsAt: new Date(NOW + startOffset).toISOString(),
  endsAt: endOffset === null ? null : new Date(NOW + endOffset).toISOString(),
  createdBy: null,
  createdAt: new Date(NOW - 100 * H).toISOString(),
  rsvpCount: 0,
  me: false
})

it('picks the earliest upcoming event within the horizon', () => {
  expect(nextEvent([ev('later', 30 * H), ev('soon', 2 * H)], NOW)?.id).toBe('soon')
})

it('ignores events past the horizon and events that ended', () => {
  expect(nextEvent([ev('far', NEXT_EVENT_HORIZON_MS + 1)], NOW)).toBeNull()
  expect(nextEvent([ev('done', -5 * H, -1 * H)], NOW)).toBeNull()
  expect(nextEvent([ev('open-old', -OPEN_EVENT_MS - 1)], NOW)).toBeNull()
})

it('prefers an ongoing event over an upcoming one', () => {
  expect(nextEvent([ev('soon', 1 * H), ev('live', -1 * H, 1 * H)], NOW)?.id).toBe('live')
  // Two ongoing: the one that started last.
  const both = [ev('soon', 1 * H), ev('live', -1 * H, 1 * H), ev('open', -0.5 * H)]
  expect(nextEvent(both, NOW)?.id).toBe('open')
})
