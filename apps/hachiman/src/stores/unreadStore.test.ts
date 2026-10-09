import type { Channel } from '@hachiman/client'
import { describe, expect, it } from 'vitest'
import { shouldPing, visibleBadge, type NotifyPrefs } from '@/lib/notify'
import {
  addMentions,
  addUnread,
  bumpLastAt,
  firstUnreadId,
  fromReadStates,
  keepChannels,
  lastAtFromReadStates,
  markReadTo,
  sumBadges
} from '@/stores/unreadStore'

const ready = fromReadStates([
  {
    channelId: 'lfg',
    lastReadMessageId: 'm1',
    unreadCount: 2,
    lastMessageId: 'm3',
    lastMessageAt: null
  },
  {
    channelId: 'news',
    lastReadMessageId: null,
    unreadCount: 0,
    lastMessageId: 'n9',
    lastMessageAt: null
  },
  {
    channelId: 'quiet',
    lastReadMessageId: 'q1',
    unreadCount: 0,
    lastMessageId: 'q1',
    lastMessageAt: null
  },
  {
    channelId: 'dm',
    lastReadMessageId: null,
    unreadCount: 0,
    lastMessageId: null,
    lastMessageAt: null
  }
])

const channel = (id: string, guildId: string | null): Channel =>
  ({ id, guildId, type: guildId ? 'text' : 'dm' }) as Channel
const channels = new Map([
  ['lfg', channel('lfg', 'g1')],
  ['news', channel('news', 'g1')],
  ['quiet', channel('quiet', 'g2')],
  ['dm', channel('dm', null)]
])
const noPrefs: NotifyPrefs = { notify: {}, muted: [] }

describe('unread reducers', () => {
  it('READY: the server counts; a never-read channel with messages is unread', () => {
    expect(ready.get('lfg')).toMatchObject({ lastReadId: 'm1', unread: 2, mentions: 0 })
    expect(ready.get('news')?.unread).toBe(1)
    expect(ready.get('quiet')?.unread).toBe(0)
    expect(ready.get('dm')?.unread).toBe(0)
  })

  it('message create and mention count; a mention counts once', () => {
    let m = addUnread(ready, 'quiet')
    m = addMentions(m, 'quiet', ['q2'])
    m = addMentions(m, 'quiet', ['q2', 'q3'])
    expect(m.get('quiet')).toEqual({
      lastReadId: 'q1',
      unread: 1,
      mentions: 2,
      mentionIds: ['q2', 'q3']
    })
    expect(ready.get('quiet')?.unread).toBe(0) // not mutated
  })

  it('a read update clears the counts', () => {
    const m = markReadTo(addMentions(ready, 'lfg', ['m3']), 'lfg', 'm3')
    expect(m.get('lfg')).toEqual({ lastReadId: 'm3', unread: 0, mentions: 0, mentionIds: [] })
    expect(markReadTo(m, 'lfg', 'm3')).toBe(m)
  })

  it('drops the channels that are gone', () => {
    const m = keepChannels(ready, new Map([['lfg', 1]]))
    expect([...m.keys()]).toEqual(['lfg'])
    expect(keepChannels(m, channels)).toBe(m)
  })

  it('sums a guild and applies mute and levels', () => {
    const m = addMentions(addUnread(ready, 'dm'), 'lfg', ['m2'])
    const g1 = (c: Channel): boolean => c.guildId === 'g1'
    expect(sumBadges(m, channels, noPrefs, g1)).toEqual({ unread: true, mentions: 1 })
    // A muted guild: no dot, mentions stay.
    expect(sumBadges(m, channels, { notify: {}, muted: ['g1'] }, g1)).toEqual({
      unread: false,
      mentions: 1
    })
    // 'none' on the channel: nothing from it.
    const none: NotifyPrefs = { notify: { lfg: 'none' }, muted: [] }
    expect(sumBadges(m, channels, none, g1)).toEqual({ unread: true, mentions: 0 })
    expect(sumBadges(m, channels, noPrefs, (c) => c.guildId === null)).toEqual({
      unread: true,
      mentions: 0
    })
  })

  it('levels: sounds and badges', () => {
    expect(shouldPing('mentions', false, false)).toBe(false)
    expect(shouldPing('mentions', true, true)).toBe(true)
    expect(shouldPing('all', false, false)).toBe(true)
    expect(shouldPing('all', true, false)).toBe(false)
    expect(shouldPing('none', false, true)).toBe(false)
    expect(visibleBadge({ unread: 3, mentions: 1 }, 'all', true)).toEqual({
      unread: false,
      mentions: 1
    })
  })

  it('NEW divider: the first message after the read point at open', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    expect(firstUnreadId(rows, { lastReadId: 'a', unread: 2 })).toBe('b')
    expect(firstUnreadId(rows, { lastReadId: 'c', unread: 0 })).toBeNull()
    // The read point is not loaded: the last `unread` rows.
    expect(firstUnreadId(rows, { lastReadId: 'old', unread: 1 })).toBe('c')
    expect(firstUnreadId(rows, { lastReadId: null, unread: 9 })).toBe('a')
    expect(firstUnreadId(rows, null)).toBeNull()
  })

  it('last activity: READY lastMessageAt, then only forward', () => {
    const m = lastAtFromReadStates([
      {
        channelId: 'a',
        lastReadMessageId: null,
        unreadCount: 0,
        lastMessageId: 'x',
        lastMessageAt: '2026-10-09T10:00:00Z'
      },
      {
        channelId: 'b',
        lastReadMessageId: null,
        unreadCount: 0,
        lastMessageId: null,
        lastMessageAt: null
      }
    ])
    expect([...m]).toEqual([['a', Date.parse('2026-10-09T10:00:00Z')]])
    const later = Date.parse('2026-10-09T10:00:00.5Z')
    expect(bumpLastAt(m, 'a', later).get('a')).toBe(later)
    expect(bumpLastAt(m, 'a', 0)).toBe(m)
    expect(bumpLastAt(m, 'b', NaN)).toBe(m)
  })
})
