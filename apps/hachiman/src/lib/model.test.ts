import { describe, expect, it } from 'vitest'
import { channelKindName, guildAfterLeave, inviteLimitsText } from '@/lib/model'

describe('channelKindName', () => {
  it('names each guild channel type', () => {
    expect(channelKindName('text')).toBe('Text channel')
    expect(channelKindName('voice')).toBe('Voice channel')
    expect(channelKindName('pages')).toBe('Pages channel')
    expect(channelKindName('category')).toBe('Category')
  })
})

describe('guildAfterLeave', () => {
  const order = ['a', 'b', 'c']

  it('picks the next guild in the order', () => {
    expect(guildAfterLeave(order, 'a')).toBe('b')
    expect(guildAfterLeave(order, 'b')).toBe('c')
  })

  it('picks the one before when the last guild is left', () => {
    expect(guildAfterLeave(order, 'c')).toBe('b')
  })

  it('gives null when no other guild is left, or the guild is not in the order', () => {
    expect(guildAfterLeave(['a'], 'a')).toBeNull()
    expect(guildAfterLeave(order, 'x')).toBeNull()
    expect(guildAfterLeave([], 'a')).toBeNull()
  })
})

describe('inviteLimitsText', () => {
  // Local time, so the spelled date does not depend on the time zone of the test run.
  const now = new Date(2026, 9, 6, 12, 0).getTime()
  const DAY = 86_400_000

  it('spells the date of an expiry a day or more away (M46)', () => {
    expect(inviteLimitsText({ expiresAt: now + 7 * DAY, maxUses: 0 }, now, 'en-GB')).toBe(
      'Expires in 7 days, on Tuesday 13 October. Anyone with the link can join, as many times as they like.'
    )
    expect(inviteLimitsText({ expiresAt: now + DAY, maxUses: 1 }, now, 'en-GB')).toBe(
      'Expires in 1 day, on Wednesday 7 October. One person can join with it.'
    )
  })

  it('gives the time of an expiry under a day away', () => {
    expect(inviteLimitsText({ expiresAt: now + 30 * 60_000, maxUses: 25 }, now, 'en-GB')).toBe(
      'Expires in 30 minutes, at 12:30. Up to 25 people can join with it.'
    )
    expect(inviteLimitsText({ expiresAt: now + 3_600_000, maxUses: 0 }, now, 'en-GB')).toMatch(
      /^Expires in 1 hour, at 13:00\./
    )
  })

  it('rounds a link made a moment ago to its whole span', () => {
    expect(inviteLimitsText({ expiresAt: now + DAY - 5_000, maxUses: 0 }, now, 'en-GB')).toMatch(
      /^Expires in 1 day, /
    )
  })

  it('adds the year to a date in another year', () => {
    const late = new Date(2026, 11, 30, 12, 0).getTime()
    expect(inviteLimitsText({ expiresAt: late + 7 * DAY, maxUses: 0 }, late, 'en-GB')).toMatch(
      /^Expires in 7 days, on Wednesday,? 6 January 2027\./
    )
  })

  it('says when a link never expires', () => {
    expect(inviteLimitsText({ expiresAt: null, maxUses: 0 }, now, 'en-GB')).toBe(
      'This link never expires. Revoke it in Guild settings when you do not need it. Anyone with the link can join, as many times as they like.'
    )
  })
})
