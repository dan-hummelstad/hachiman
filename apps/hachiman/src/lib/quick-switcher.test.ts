import { describe, expect, it } from 'vitest'
import { matchTier, rankItems, recentKeys, type SwitchItem } from '@/lib/quick-switcher'
import type { View } from '@/stores/navStore'

const item = (key: string, name: string, kind: SwitchItem['kind'] = 'text'): SwitchItem => ({
  key,
  kind,
  name,
  guildId: 'g',
  guildName: 'Guild',
  channelId: key.slice(2)
})

describe('matchTier', () => {
  it('ranks a prefix, then a word start, then an inner match', () => {
    expect(matchTier('general', 'gen')).toBe(0)
    expect(matchTier('RFC: pages channels', 'PAGES')).toBe(1)
    expect(matchTier('scrim-playbook', 'play')).toBe(1)
    expect(matchTier('lounge', 'unge')).toBe(2)
    expect(matchTier('lounge', 'xyz')).toBe(-1)
  })
})

describe('rankItems', () => {
  const items = [
    item('c:1', 'general'),
    item('c:2', 'gaming-general'),
    item('c:3', 'lounge', 'voice'),
    item('p:4', 'General notes', 'page'),
    item('u:5', 'genny', 'person')
  ]

  it('keeps substring matches only, case-insensitive', () => {
    expect(rankItems(items, 'LOUN', []).map((i) => i.key)).toEqual(['c:3'])
    expect(rankItems(items, 'zzz', [])).toEqual([])
  })

  it('ranks by tier, then recent use, then name', () => {
    expect(rankItems(items, 'gen', []).map((i) => i.key)).toEqual(['c:1', 'p:4', 'u:5', 'c:2'])
    expect(rankItems(items, 'gen', ['u:5', 'p:4']).map((i) => i.key)).toEqual([
      'u:5',
      'p:4',
      'c:1',
      'c:2'
    ])
  })

  it('lists recent items first for an empty query, and caps the list', () => {
    expect(rankItems(items, '  ', ['c:3']).map((i) => i.key)[0]).toBe('c:3')
    expect(rankItems(items, '', [], 2)).toHaveLength(2)
  })
})

describe('recentKeys', () => {
  it('lists the current view first, then the history newest first, without repeats', () => {
    const past: View[] = [
      { kind: 'channel', guildId: 'g', channelId: '1' },
      { kind: 'dmHome' },
      { kind: 'page', guildId: 'g', channelId: '2', pageId: 'p' },
      { kind: 'channel', guildId: 'g', channelId: '1' }
    ]
    expect(recentKeys(past, { kind: 'dm', channelId: '9' })).toEqual(['c:9', 'c:1', 'p:p'])
  })
})
