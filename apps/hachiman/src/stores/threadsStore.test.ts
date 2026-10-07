import { expect, it } from 'vitest'
import type { Channel } from '@hachiman/client'
import { threadCount, threadsOf } from './threadsStore'

const ch = (id: string, type: Channel['type'], parentId: string | null, name = id): Channel => ({
  id,
  guildId: 'g',
  type,
  name,
  topic: null,
  parentId,
  position: 0,
  permissionOverwrites: [],
  mlsGroupId: null,
  historyVisibility: null
})

const channels = new Map(
  [
    ch('general', 'text', null),
    ch('t-a', 'thread', 'general', 'Alpha'),
    ch('t-b', 'thread', 'general', 'Bravo'),
    ch('t-c', 'thread', 'general', 'Charlie'),
    ch('t-x', 'thread', 'other'),
    ch('cat', 'category', null),
    ch('child', 'text', 'cat')
  ].map((c) => [c.id, c])
)

it('counts the threads of one parent only', () => {
  expect(threadCount(channels, 'general')).toBe(3)
  expect(threadCount(channels, 'cat')).toBe(0)
})

it('sorts by the newest loaded message, then the list order, then the name', () => {
  const activity: Record<string, string> = { 't-c': '2026-10-07T10:00:00Z' }
  const ids = (order?: string[]): string[] =>
    threadsOf(channels, 'general', (id) => activity[id] ?? null, order).map((c) => c.id)
  expect(ids()).toEqual(['t-c', 't-a', 't-b'])
  expect(ids(['t-b', 't-a'])).toEqual(['t-c', 't-b', 't-a'])
  activity['t-a'] = '2026-10-07T11:00:00Z'
  expect(ids(['t-b', 't-a'])).toEqual(['t-a', 't-c', 't-b'])
})
