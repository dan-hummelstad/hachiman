/**
 * Pins, guild events and blocks (docs/gateway-protocol.md §4 "Pins, guild
 * events and blocks"): the rules of the routes and the bus envelopes of their
 * events. No DB / Redis: publishes are captured.
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import { DM_PERMISSIONS, Permissions } from '@hachiman/client/permissions'

import type { GuildEventRow } from '@/db/schema'
import { blockedError } from '@/lib/blocks'
import { ApiError, MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToGuild, publishToUser, setBusPublisher } from '@/lib/events'
import { publishToChannel } from '@/lib/guild-access'
import {
  createEventSchema,
  eventTimes,
  eventTimesError,
  isListed,
  MAX_EVENT_TITLE,
  OPEN_EVENT_LISTED_MS,
  toGuildEvent,
  updateEventSchema,
} from '@/lib/guild-events'
import { assertCanPin, assertPinRoom, MAX_PINS_PER_CHANNEL } from '@/lib/pins'

const NOW = new Date('2026-10-07T12:00:00Z')
const HOUR = 3600_000
const at = (ms: number) => new Date(NOW.getTime() + ms)

const published: { channel: string; payload: unknown }[] = []
setBusPublisher(async (channel, payload) => {
  published.push({ channel, payload: JSON.parse(payload) })
})
after(() => setBusPublisher(null))

describe('pins', () => {
  test('the 51st pin is a 400 TooManyPins', () => {
    assert.doesNotThrow(() => assertPinRoom(MAX_PINS_PER_CHANNEL - 1))
    assert.throws(
      () => assertPinRoom(MAX_PINS_PER_CHANNEL),
      (e: unknown) => e instanceof ApiError && e.code === 'TooManyPins' && e.status === 400,
    )
  })

  test('a guild channel needs MANAGE_MESSAGES, a DM participant may pin', () => {
    const guild = { guildId: 'g' }
    assert.throws(() => assertCanPin({ channel: guild, permissions: Permissions.VIEW_CHANNEL }), MissingPermissionsError)
    assert.doesNotThrow(() => assertCanPin({ channel: guild, permissions: Permissions.MANAGE_MESSAGES }))
    assert.doesNotThrow(() => assertCanPin({ channel: { guildId: null }, permissions: DM_PERMISSIONS }))
  })

  test('CHANNEL_PINS_UPDATE: scoped to the channel in a guild, to each participant in a DM', async () => {
    published.length = 0
    const d = { channelId: 'c', guildId: 'g' }
    await publishToChannel({ channel: { id: 'c', guildId: 'g' } as never, participantIds: [] }, 'CHANNEL_PINS_UPDATE', d)
    assert.deepEqual(published, [{ channel: 'guild:g', payload: { t: 'CHANNEL_PINS_UPDATE', d, channelId: 'c' } }])

    published.length = 0
    const dm = { channelId: 'dm', guildId: null }
    await publishToChannel({ channel: { id: 'dm', guildId: null } as never, participantIds: ['a', 'b'] }, 'CHANNEL_PINS_UPDATE', dm)
    assert.deepEqual(
      published.map((p) => p.channel).sort(),
      ['user:a', 'user:b'],
    )
  })
})

describe('guild events', () => {
  test('title is 1 to 100 characters after trim', () => {
    const ok = { title: 'Scrims', startsAt: at(HOUR).toISOString() }
    assert.equal(createEventSchema.safeParse(ok).success, true)
    assert.equal(createEventSchema.safeParse({ ...ok, title: '   ' }).success, false)
    assert.equal(createEventSchema.safeParse({ ...ok, title: 'x'.repeat(MAX_EVENT_TITLE) }).success, true)
    assert.equal(createEventSchema.safeParse({ ...ok, title: 'x'.repeat(MAX_EVENT_TITLE + 1) }).success, false)
    assert.equal(createEventSchema.safeParse({ title: 'Scrims' }).success, false)
    assert.equal(createEventSchema.safeParse({ ...ok, startsAt: 'tomorrow' }).success, false)
    assert.equal(updateEventSchema.safeParse({}).success, true)
  })

  test('create: startsAt in the future, endsAt after startsAt', () => {
    assert.deepEqual(eventTimes({ startsAt: at(HOUR).toISOString() }, NOW), { startsAt: at(HOUR), endsAt: null })
    assert.throws(() => eventTimes({ startsAt: NOW.toISOString() }, NOW), ValidationError)
    assert.throws(() => eventTimes({ startsAt: at(-HOUR).toISOString() }, NOW), ValidationError)
    assert.throws(() => eventTimes({ startsAt: at(HOUR).toISOString(), endsAt: at(HOUR).toISOString() }, NOW), ValidationError)
    assert.deepEqual(eventTimes({ startsAt: at(HOUR).toISOString(), endsAt: at(2 * HOUR).toISOString() }, NOW), {
      startsAt: at(HOUR),
      endsAt: at(2 * HOUR),
    })
  })

  test('update: an ongoing event can change its end, and the merged times must stay ordered', () => {
    const current = { startsAt: at(-HOUR), endsAt: at(HOUR) }
    assert.deepEqual(eventTimes({ endsAt: at(3 * HOUR).toISOString() }, NOW, current), { startsAt: at(-HOUR), endsAt: at(3 * HOUR) })
    assert.deepEqual(eventTimes({ endsAt: null }, NOW, current), { startsAt: at(-HOUR), endsAt: null })
    assert.deepEqual(eventTimes({}, NOW, current), current)
    assert.throws(() => eventTimes({ endsAt: at(-2 * HOUR).toISOString() }, NOW, current), ValidationError)
    assert.throws(() => eventTimes({ startsAt: at(2 * HOUR).toISOString() }, NOW, current), ValidationError)
  })

  test('update: the CHECK violation of a concurrent PATCH is the same 400', () => {
    assert.ok(eventTimesError(new Error('query failed', { cause: { code: '23514' } })) instanceof ValidationError)
    const other = new Error('other')
    assert.equal(eventTimesError(other), other)
  })

  test('listed while upcoming or ongoing; an event with no end for 6 h after its start', () => {
    assert.equal(isListed({ startsAt: at(HOUR), endsAt: null }, NOW), true)
    assert.equal(isListed({ startsAt: at(-HOUR), endsAt: at(HOUR) }, NOW), true)
    assert.equal(isListed({ startsAt: at(-2 * HOUR), endsAt: at(-HOUR) }, NOW), false)
    assert.equal(isListed({ startsAt: at(-OPEN_EVENT_LISTED_MS + 1), endsAt: null }, NOW), true)
    assert.equal(isListed({ startsAt: at(-OPEN_EVENT_LISTED_MS), endsAt: null }, NOW), false)
  })

  test('wire shape and the GUILD_EVENT_* envelopes on guild:{id}', async () => {
    const row: GuildEventRow = {
      id: 'e',
      guildId: 'g',
      channelId: null,
      title: 'Scrims',
      startsAt: at(HOUR),
      endsAt: null,
      createdBy: 'u',
      createdAt: NOW,
    }
    const event = toGuildEvent(row, 3)
    assert.deepEqual(event, {
      id: 'e',
      guildId: 'g',
      channelId: null,
      title: 'Scrims',
      startsAt: at(HOUR).toISOString(),
      endsAt: null,
      createdBy: 'u',
      createdAt: NOW.toISOString(),
      rsvpCount: 3,
    })
    published.length = 0
    await publishToGuild('g', 'GUILD_EVENT_CREATE', event)
    await publishToGuild('g', 'GUILD_EVENT_RSVP', { eventId: 'e', guildId: 'g', userId: 'u', going: true, rsvpCount: 4 })
    await publishToGuild('g', 'GUILD_EVENT_DELETE', { id: 'e', guildId: 'g' })
    assert.deepEqual(
      published.map((p) => [p.channel, (p.payload as { t: string; channelId?: string }).t, (p.payload as { channelId?: string }).channelId]),
      [
        ['guild:g', 'GUILD_EVENT_CREATE', undefined],
        ['guild:g', 'GUILD_EVENT_RSVP', undefined],
        ['guild:g', 'GUILD_EVENT_DELETE', undefined],
      ],
    )
  })
})

describe('blocks', () => {
  test('a block is a 403 Blocked', () => {
    const e = blockedError()
    assert.equal(e.code, 'Blocked')
    assert.equal(e.status, 403)
  })

  test('USER_BLOCK_UPDATE goes to the blocker only', async () => {
    published.length = 0
    await publishToUser('me', 'USER_BLOCK_UPDATE', { userId: 'them', blocked: true })
    assert.deepEqual(published, [{ channel: 'user:me', payload: { t: 'USER_BLOCK_UPDATE', d: { userId: 'them', blocked: true } } }])
  })
})
