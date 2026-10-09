import { describe, expect, it } from 'vitest'
import type { Channel } from '@hachiman/client'
import { callStartedAt } from './call-timer'
import { dragged, orderedIds, recentDms, rowSlice } from './sidebar-tiles'
import { formatClock } from './time-format'

describe('callStartedAt (N17)', () => {
  it('is the oldest joinedAt of the participants', () => {
    const t = callStartedAt([
      { joinedAt: '2026-10-07T10:05:00Z' },
      { joinedAt: '2026-10-07T09:00:00Z' },
      { joinedAt: '2026-10-07T09:30:00Z' }
    ])
    expect(t).toBe(Date.parse('2026-10-07T09:00:00Z'))
  })

  it('skips a missing or invalid joinedAt', () => {
    expect(callStartedAt([{}, { joinedAt: 'nope' }, { joinedAt: '2026-10-07T10:00:00Z' }])).toBe(
      Date.parse('2026-10-07T10:00:00Z')
    )
  })

  it('is null with no participant or no joinedAt (an older gateway)', () => {
    expect(callStartedAt([])).toBeNull()
    expect(callStartedAt([{}, {}])).toBeNull()
  })

  it('formats as the B1 chip', () => {
    const start = callStartedAt([{ joinedAt: '2026-10-07T10:00:00Z' }])!
    expect(formatClock(start + (3600 + 24 * 60 + 7) * 1000 - start)).toBe('1:24:07')
  })
})

const ch = (id: string, guildId: string | null = null): Channel =>
  ({ id, guildId, type: guildId === null ? 'dm' : 'text', name: null }) as Channel

describe('sidebar tile rows', () => {
  it('orders DMs by the newest message; a DM with none follows in place', () => {
    const dms = [ch('a'), ch('b'), ch('c'), ch('d')]
    const lastAt = new Map([
      ['a', 100],
      ['c', 300],
      ['b', 200]
    ])
    expect(recentDms(dms, lastAt)).toEqual(['c', 'b', 'a', 'd'])
    // A new message in a: it moves to the front, the rest shift right.
    expect(recentDms(dms, new Map(lastAt).set('a', 400))).toEqual(['a', 'c', 'b', 'd'])
  })

  it('keeps the user order of guilds; a new guild follows', () => {
    expect(orderedIds(['g1', 'g2', 'g3', 'g4'], ['g3', 'gone', 'g1'])).toEqual([
      'g3',
      'g1',
      'g2',
      'g4'
    ])
  })

  it('shows four tiles and clusters the rest', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(rowSlice(ids, false)).toEqual({
      tiles: ['a', 'b', 'c', 'd'],
      hidden: ['e', 'f'],
      cluster: true
    })
  })

  it('shows up to five guilds with no cluster; the DM row always has one', () => {
    const five = ['a', 'b', 'c', 'd', 'e']
    expect(rowSlice(five, false)).toEqual({ tiles: five, hidden: [], cluster: false })
    expect(rowSlice(five, true)).toEqual({
      tiles: ['a', 'b', 'c', 'd'],
      hidden: ['e'],
      cluster: true
    })
    expect(rowSlice(['a'], true)).toEqual({ tiles: ['a'], hidden: [], cluster: true })
  })

  it('moves a dragged guild onto the place of the target', () => {
    const order = ['a', 'b', 'c', 'd']
    expect(dragged(order, 'd', 'a')).toEqual(['d', 'a', 'b', 'c'])
    expect(dragged(order, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(dragged(order, 'a', 'a')).toBeNull()
    expect(dragged(order, 'x', 'a')).toBeNull()
  })
})
