import { describe, expect, it } from 'vitest'
import type { Channel } from '@hachiman/client'
import type { NotifyPrefs } from '@/lib/notify'
import type { ChatMessage } from '@/stores/messagesStore'
import type { ChannelUnread } from '@/stores/unreadStore'
import {
  filterInbox,
  inboxCounts,
  inboxEntries,
  mentionEntries,
  unreadGroups,
  type InboxEntry,
  type MentionEntry,
  type UnreadChannel
} from './inbox-model'

const ch = (id: string, guildId: string | null, position = 0): Channel => ({
  id,
  guildId,
  type: guildId === null ? 'dm' : 'text',
  name: id,
  topic: null,
  parentId: null,
  position,
  permissionOverwrites: [],
  mlsGroupId: null,
  historyVisibility: null
})

const channels = new Map(
  [ch('a', 'g1', 1), ch('b', 'g1', 0), ch('c', 'g2'), ch('dm', null)].map((c) => [c.id, c])
)
const guilds = new Map([
  ['g1', { name: 'Night Owls' }],
  ['g2', { name: 'Arcade' }]
])
const u = (unread: number, mentionIds: string[] = []): ChannelUnread => ({
  lastReadId: null,
  unread,
  mentions: mentionIds.length,
  mentionIds
})
const row = (id: string, createdAt: string): ChatMessage => ({ id, createdAt }) as ChatMessage
const prefs: NotifyPrefs = { notify: {}, muted: [] }

it('lists loaded mentions newest first, then the unloaded ones', () => {
  const unread = new Map([
    ['a', u(2, ['m1', 'm2'])],
    ['c', u(1, ['m3'])],
    ['gone', u(1, ['m4'])]
  ])
  const messages = new Map([
    ['a', [row('m1', '2026-10-07T10:00:00Z'), row('m2', '2026-10-07T12:00:00Z')]]
  ])
  expect(mentionEntries(unread, messages, channels).map((e) => e.messageId)).toEqual([
    'm2',
    'm1',
    'm3'
  ])
})

it('groups unread channels by guild, DMs first, sidebar order inside', () => {
  const unread = new Map([
    ['a', u(1)],
    ['b', u(3)],
    ['c', u(0, ['m'])],
    ['dm', u(1)]
  ])
  const groups = unreadGroups(unread, channels, guilds, prefs)
  expect(groups.map((g) => [g.name, g.channels.map((c) => c.channel.id)])).toEqual([
    ['Direct messages', ['dm']],
    ['Arcade', ['c']],
    ['Night Owls', ['b', 'a']]
  ])
})

it('applies the notification level and mute', () => {
  const unread = new Map([
    ['a', u(1)],
    ['b', u(1, ['m'])],
    ['c', u(1)]
  ])
  const p: NotifyPrefs = { notify: { a: 'none' }, muted: ['g2'] }
  const groups = unreadGroups(unread, channels, guilds, p)
  expect(groups.map((g) => g.channels.map((c) => c.channel.id))).toEqual([['b']])
  expect(groups[0].channels[0].badge).toEqual({ unread: true, mentions: 1 })
})

it('keeps the raw new-message count on each unread channel', () => {
  const groups = unreadGroups(new Map([['a', u(4, ['m'])]]), channels, guilds, prefs)
  expect(groups[0].channels[0].unread).toBe(4)
})

const mention = (channelId: string, messageId: string, at?: string): MentionEntry => ({
  channelId,
  messageId,
  row: at === undefined ? undefined : row(messageId, at)
})
const unreadChannel = (id: string, unread: number, badgeUnread = true): UnreadChannel => ({
  channel: channels.get(id)!,
  badge: { unread: badgeUnread, mentions: 0 },
  unread
})
const keys = (entries: readonly InboxEntry[]): string[] => entries.map((e) => e.key)

describe('inbox screen entries', () => {
  const lastAt = new Map([
    ['a', Date.parse('2026-10-07T11:00:00Z')],
    ['b', Date.parse('2026-10-07T12:30:00Z')]
  ])

  it('lists mentions and channels newest first, entries with no time last', () => {
    const entries = inboxEntries(
      [
        mention('a', 'm1', '2026-10-07T12:00:00Z'),
        mention('c', 'm2'),
        mention('a', 'm3', '2026-10-07T09:00:00Z')
      ],
      [unreadChannel('a', 5), unreadChannel('b', 1), unreadChannel('dm', 2)],
      lastAt
    )
    expect(keys(entries)).toEqual([
      'channel:b',
      'mention:m1',
      'channel:a',
      'mention:m3',
      'mention:m2',
      'channel:dm'
    ])
    expect(entries.map((e) => e.kind)).toEqual([
      'channel',
      'mention',
      'channel',
      'mention',
      'mention',
      'channel'
    ])
  })

  it('puts a mention before its channel on the same time', () => {
    const at = '2026-10-07T11:00:00Z'
    const entries = inboxEntries([mention('a', 'm1', at)], [unreadChannel('a', 3)], lastAt)
    expect(keys(entries)).toEqual(['mention:m1', 'channel:a'])
  })

  it('filters by kind; All drops a channel that its listed mentions cover', () => {
    const entries = inboxEntries(
      [mention('a', 'm1', '2026-10-07T10:00:00Z'), mention('b', 'm2'), mention('b', 'm3')],
      [
        // Three new messages, one listed mention: it stays.
        unreadChannel('a', 3),
        // Two new messages, both listed as mentions: covered.
        unreadChannel('b', 2),
        // Muted: the badge shows its mention only.
        unreadChannel('c', 4, false),
        unreadChannel('dm', 1)
      ],
      new Map()
    )
    expect(keys(filterInbox(entries, 'all'))).toEqual([
      'mention:m1',
      'mention:m2',
      'mention:m3',
      'channel:a',
      'channel:dm'
    ])
    expect(keys(filterInbox(entries, 'mentions'))).toEqual([
      'mention:m1',
      'mention:m2',
      'mention:m3'
    ])
    expect(keys(filterInbox(entries, 'channels'))).toEqual([
      'channel:a',
      'channel:b',
      'channel:c',
      'channel:dm'
    ])
    expect(inboxCounts(entries)).toEqual({ all: 5, mentions: 3, channels: 4 })
  })

  it('counts nothing for an empty inbox', () => {
    expect(inboxCounts(inboxEntries([], [], new Map()))).toEqual({
      all: 0,
      mentions: 0,
      channels: 0
    })
  })
})
