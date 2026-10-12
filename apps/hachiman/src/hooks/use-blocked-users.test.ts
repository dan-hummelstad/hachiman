import { describe, expect, it } from 'vitest'
import type { User } from '@hachiman/client'
import { blockedLine, resolveBlockedUsers } from './use-blocked-users'

const user = (id: string, username: string): User => ({ id, username, avatar: null }) as User

describe('resolveBlockedUsers', () => {
  it('keeps the known blocked users by name and flags a missing one', () => {
    const known = new Map([
      ['1', user('1', 'spamlord')],
      ['2', user('2', 'n0va_x')],
      ['3', user('3', 'friend')]
    ])
    expect(resolveBlockedUsers(new Set(['1', '2']), known)).toEqual({
      users: [user('2', 'n0va_x'), user('1', 'spamlord')],
      missing: false
    })
    expect(resolveBlockedUsers(new Set(['1', '9']), known)).toEqual({
      users: [user('1', 'spamlord')],
      missing: true
    })
    expect(resolveBlockedUsers(new Set(), known)).toEqual({ users: [], missing: false })
  })
})

describe('blockedLine', () => {
  const now = new Date(2026, 9, 11, 12).getTime()

  it('gives the day and month of this year, with the year for an older block', () => {
    expect(blockedLine(new Date(2026, 9, 3, 9).toISOString(), now, 'en-GB')).toBe('Blocked 3 Oct')
    // ICU spells September "Sep" or "Sept".
    expect(blockedLine(new Date(2025, 8, 18, 9).toISOString(), now, 'en-GB')).toMatch(
      /^Blocked 18 Sept? 2025$/
    )
  })

  it('says only "Blocked" with no time or a broken one', () => {
    expect(blockedLine(undefined, now)).toBe('Blocked')
    expect(blockedLine('not a date', now)).toBe('Blocked')
  })
})
