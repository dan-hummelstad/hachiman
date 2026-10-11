import { describe, expect, it } from 'vitest'
import type { BlockedUser, User } from '@hachiman/client'
import { nextBlockedState, type BlockedState } from './guild-features'

const user = (id: string): User => ({ id, username: `u${id}`, avatar: null }) as User
const entry = (id: string, createdAt: string): BlockedUser => ({ user: user(id), createdAt })
const EMPTY: BlockedState = { blockedUsers: new Map(), blockedAt: new Map() }
const NOW = '2026-10-11T12:00:00.000Z'

describe('nextBlockedState', () => {
  it('takes the users and the block times from a block list', () => {
    const next = nextBlockedState(
      new Set(['1', '2']),
      EMPTY,
      [entry('1', '2026-10-03T09:00:00.000Z'), entry('2', '')],
      undefined,
      NOW
    )
    expect([...next.blockedUsers.keys()]).toEqual(['1', '2'])
    expect([...next.blockedAt]).toEqual([['1', '2026-10-03T09:00:00.000Z']])
  })

  it('gives a block since the list the time of its event', () => {
    const prev = nextBlockedState(new Set(['1']), EMPTY, [entry('1', '2026-10-03T09:00:00.000Z')])
    const next = nextBlockedState(new Set(['1', '2']), prev, undefined, '2', NOW)
    expect(next.blockedAt.get('1')).toBe('2026-10-03T09:00:00.000Z')
    expect(next.blockedAt.get('2')).toBe(NOW)
    expect(next.blockedUsers.has('2')).toBe(false)
    // A repeated event keeps the first time.
    const again = nextBlockedState(
      new Set(['1', '2']),
      next,
      undefined,
      '2',
      '2027-01-01T00:00:00Z'
    )
    expect(again.blockedAt.get('2')).toBe(NOW)
  })

  it('drops an unblocked user and its time', () => {
    const prev = nextBlockedState(new Set(['1', '2']), EMPTY, [
      entry('1', '2026-10-03T09:00:00.000Z'),
      entry('2', '2026-09-18T09:00:00.000Z')
    ])
    const next = nextBlockedState(new Set(['2']), prev)
    expect([...next.blockedUsers.keys()]).toEqual(['2'])
    expect([...next.blockedAt.keys()]).toEqual(['2'])
  })
})
