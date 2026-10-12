import { describe, expect, it } from 'vitest'
import {
  ANY_RESULT,
  groupResults,
  inFilter,
  initialFilterKind,
  matchRange,
  matchTier,
  rankItems,
  recentKeys,
  type SwitchItem
} from '@/lib/quick-switcher'
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

describe('matchRange', () => {
  it('finds the place that matchTier ranks: the start, then a word start, then the first match', () => {
    expect(matchRange('Quill clutch', 'qu')).toEqual([0, 2])
    expect(matchRange('Ranked queue', 'QU')).toEqual([7, 9])
    expect(matchRange('squad queue', 'qu')).toEqual([6, 8])
    expect(matchRange('scrim-playbook', 'play')).toEqual([6, 10])
    expect(matchRange('lounge', 'unge')).toEqual([2, 6])
  })

  it('trims the query and gives null for no match or an empty query', () => {
    expect(matchRange('general', '  gen ')).toEqual([0, 3])
    expect(matchRange('general', 'xyz')).toBeNull()
    expect(matchRange('general', '   ')).toBeNull()
  })

  it('gives null when lower case changes the length of the name', () => {
    expect(matchRange('İstanbul', 'stan')).toBeNull()
  })
})

describe('inFilter', () => {
  const channel = item('c:1', 'general')
  const dm: SwitchItem = { ...item('c:2', 'quill', 'dm'), guildId: null, guildIds: ['g', 'h'] }
  const person: SwitchItem = {
    ...item('u:3', 'yuki', 'person'),
    guildId: null,
    channelId: null,
    guildIds: ['h']
  }

  it('passes everything with no filter', () => {
    expect([channel, dm, person].every((it) => inFilter(it, ANY_RESULT))).toBe(true)
  })

  it('keeps DMs and people under People, channels and pages under Channels', () => {
    const page = item('p:4', 'Notes', 'page')
    const people = { kind: 'people', guildId: null } as const
    const channels = { kind: 'channels', guildId: null } as const
    expect([channel, page, dm, person].map((it) => inFilter(it, people))).toEqual([
      false,
      false,
      true,
      true
    ])
    expect([channel, page, dm, person].map((it) => inFilter(it, channels))).toEqual([
      true,
      true,
      false,
      false
    ])
  })

  it('keeps the channels of the guild and the people who are members of it', () => {
    const inG = { kind: 'all', guildId: 'g' } as const
    expect([channel, dm, person].map((it) => inFilter(it, inG))).toEqual([true, true, false])
    expect(inFilter({ ...channel, guildIds: undefined }, { kind: 'all', guildId: 'h' })).toBe(false)
  })
})

describe('initialFilterKind', () => {
  it('starts on People over the DM home, else on All', () => {
    expect(initialFilterKind({ kind: 'dmHome' })).toBe('people')
    expect(initialFilterKind({ kind: 'dm', channelId: '1' })).toBe('all')
    expect(initialFilterKind({ kind: 'channel', guildId: 'g', channelId: '1' })).toBe('all')
  })
})

describe('groupResults', () => {
  const results = [
    item('c:1', 'queue'),
    item('u:2', 'quill', 'person'),
    item('p:3', 'Quests', 'page'),
    item('c:4', 'quiet', 'dm'),
    item('c:5', 'quarry', 'voice')
  ]

  it('puts recent results first, newest first, then channels and people in rank order', () => {
    expect(
      groupResults(results, ['c:4', 'x', 'c:5']).map((s) => [s.group, s.items.map((i) => i.key)])
    ).toEqual([
      ['recent', ['c:4', 'c:5']],
      ['channels', ['c:1', 'p:3']],
      ['people', ['u:2']]
    ])
  })

  it('caps the recent group and leaves out empty groups', () => {
    const groups = groupResults(results.slice(0, 3), ['p:3', 'c:1'], 1)
    expect(groups.map((s) => [s.group, s.items.map((i) => i.key)])).toEqual([
      ['recent', ['p:3']],
      ['channels', ['c:1']],
      ['people', ['u:2']]
    ])
    expect(groupResults([item('c:1', 'a')], []).map((s) => s.group)).toEqual(['channels'])
    expect(groupResults([], ['c:1'])).toEqual([])
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
