import { describe, expect, it } from 'vitest'
import type { Channel } from '@hachiman/client'
import { moved } from '@/stores/prefsStore'
import { callStartedAt } from './call-timer'
import { favouriteMove, favouriteTiles } from './favourite-dms'
import { formatElapsed } from './member-activity'

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
    expect(formatElapsed(start + (3600 + 24 * 60 + 7) * 1000 - start)).toBe('1:24:07')
  })
})

const ch = (id: string, guildId: string | null = null): Channel =>
  ({ id, guildId, type: guildId === null ? 'dm' : 'text', name: null }) as Channel

describe('favourite DMs (N6)', () => {
  const channels = new Map(
    [ch('a'), ch('b'), ch('c'), ch('g', 'guild')].map((c) => [c.id, c] as const)
  )

  it('keeps the stored order and drops unknown and guild channels', () => {
    const tiles = favouriteTiles(['c', 'gone', 'a', 'g'], channels)
    expect(tiles.map((c) => c.id)).toEqual(['c', 'a'])
  })

  it('maps a tile drag to indexes of the stored list', () => {
    const ids = ['c', 'gone', 'a', 'b']
    expect(favouriteMove(ids, 'b', 'c')).toEqual({ from: 3, to: 0 })
    expect(favouriteMove(ids, 'c', 'c')).toBeNull()
    expect(favouriteMove(ids, 'x', 'c')).toBeNull()
    const m = favouriteMove(ids, 'b', 'c')!
    expect(moved(ids, m.from, m.to)).toEqual(['b', 'c', 'gone', 'a'])
  })

  it('moves forward too', () => {
    const ids = ['a', 'b', 'c']
    const m = favouriteMove(ids, 'a', 'c')!
    expect(moved(ids, m.from, m.to)).toEqual(['b', 'c', 'a'])
  })
})
