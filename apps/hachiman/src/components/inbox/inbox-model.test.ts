import { expect, it } from 'vitest'
import type { Channel } from '@hachiman/client'
import type { NotifyPrefs } from '@/lib/notify'
import type { ChatMessage } from '@/stores/messagesStore'
import type { ChannelUnread } from '@/stores/unreadStore'
import { mentionEntries, unreadGroups } from './inbox-model'

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
