import { describe, expect, it } from 'vitest'
import type { Channel, Guild, Member, PresenceStatus, VoiceState } from '@hachiman/client'
import { groupMembers } from './member-groups'
import {
  activityLabel,
  formatElapsed,
  voiceActivity,
  type ActivitySources
} from './member-activity'
import { userHue } from './user-tint'
import { countWords } from './word-count'

const member = (id: string, username: string, nick: string | null = null): Member => ({
  guildId: 'g1',
  user: { id, username, avatar: null },
  nick,
  roles: [],
  joinedAt: '2026-10-01T00:00:00Z'
})

describe('groupMembers', () => {
  const members = [member('u1', 'wren'), member('u2', 'juni'), member('u3', 'ozzy', 'Aozzy')]
  it('splits online and offline, sorted by display name, idle counts as online', () => {
    const presences = new Map<string, PresenceStatus>([
      ['u1', 'idle'],
      ['u3', 'online']
    ])
    const groups = groupMembers(members, presences)
    expect(groups.map((g) => [g.id, g.dim, g.members.map((m) => m.user.id)])).toEqual([
      ['online', false, ['u3', 'u1']],
      ['offline', true, ['u2']]
    ])
  })
  it('leaves out empty sections', () => {
    expect(groupMembers(members, new Map()).map((g) => g.id)).toEqual(['offline'])
    expect(groupMembers([], new Map())).toEqual([])
  })
})

const channel = (id: string, guildId: string, name: string): Channel => ({
  id,
  guildId,
  type: 'voice',
  name,
  topic: null,
  parentId: null,
  position: 0,
  permissionOverwrites: [],
  mlsGroupId: null,
  historyVisibility: null
})
const guild = (id: string, name: string): Guild => ({
  id,
  name,
  icon: null,
  banner: null,
  ownerId: 'u0',
  region: null,
  createdAt: '2026-01-01T00:00:00Z',
  publicHistoryVisibility: 'joined'
})
const state = (guildId: string, channelId: string | null, userId: string): VoiceState => ({
  guildId,
  channelId,
  userId,
  sessionId: 's',
  selfMute: false,
  selfDeaf: false,
  selfStream: false,
  joinedAt: '2026-10-07T10:00:00Z'
})

describe('voiceActivity', () => {
  const src = (over: Partial<ActivitySources> = {}): ActivitySources => ({
    voiceStates: new Map([
      ['g1', new Map([['u1', state('g1', 'lounge', 'u1')]])],
      ['g2', new Map([['u2', state('g2', 'pairing', 'u2')]])]
    ]),
    channels: new Map([
      ['lounge', channel('lounge', 'g1', 'Lounge')],
      ['pairing', channel('pairing', 'g2', 'Pairing')]
    ]),
    guilds: new Map([
      ['g1', guild('g1', 'Night Owls')],
      ['g2', guild('g2', 'Lattice Labs')]
    ]),
    speaking: new Set(['u1', 'u2']),
    myChannelId: null,
    ...over
  })

  it('reports speaking only in the own call', () => {
    expect(activityLabel(voiceActivity('u1', 'g1', src())!)).toBe('In Lounge')
    const mine = voiceActivity('u1', 'g1', src({ myChannelId: 'lounge' }))!
    expect(mine.withMe).toBe(true)
    expect(activityLabel(mine)).toBe('Speaking in Lounge')
  })
  it('names the guild of a channel in another (shared) guild', () => {
    const a = voiceActivity('u2', 'g1', src())!
    expect(a.otherGuildName).toBe('Lattice Labs')
    expect(activityLabel(a)).toBe('In Pairing · Lattice Labs')
    expect(voiceActivity('u2', null, src())!.otherGuildName).toBe('Lattice Labs')
  })
  it('is null outside voice', () => {
    expect(voiceActivity('u9', 'g1', src())).toBeNull()
    const left = src({ voiceStates: new Map([['g1', new Map([['u1', state('g1', null, 'u1')]])]]) })
    expect(voiceActivity('u1', 'g1', left)).toBeNull()
  })
})

describe('formatElapsed', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatElapsed(-5)).toBe('0:00')
    expect(formatElapsed(65_000)).toBe('1:05')
    expect(formatElapsed((1 * 3600 + 24 * 60 + 7) * 1000)).toBe('1:24:07')
  })
})

describe('countWords', () => {
  it('counts words, not markup or link targets', () => {
    expect(countWords('')).toBe(0)
    expect(
      countWords('# RFC: pages channels\n\nThe terms are in the [Glossary](hachiman:page/x).')
    ).toBe(9)
    expect(countWords("- don't ![alt text](https://e/x.png) <br/> state-of-the-art")).toBe(4)
  })
})

describe('userHue', () => {
  it('is stable and in range', () => {
    expect(userHue('u1')).toBe(userHue('u1'))
    for (const id of ['a', 'b', 'marlowe', '']) {
      expect(userHue(id)).toBeGreaterThanOrEqual(0)
      expect(userHue(id)).toBeLessThan(360)
    }
  })
})
