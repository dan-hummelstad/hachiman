import { describe, expect, it } from 'vitest'
import type { VoicePeer, VoiceState } from '@hachiman/client'
import type { VoiceRosterEntry } from '@hachiman/crypto'
import { callParticipants, epochCodeGroups, secureUserIds } from './call-roster'

const vs = (userId: string, sessionId: string): VoiceState => ({
  guildId: 'g',
  channelId: 'c',
  userId,
  sessionId,
  selfMute: false,
  selfDeaf: false,
  selfStream: false
})
const peer = (userId: string): VoicePeer => ({ userId, ssrc: 1 })
const leaf = (userId: string, sessionId: string, leafIndex: number | null): VoiceRosterEntry => ({
  userId,
  sessionId,
  deviceId: `d-${userId}`,
  leafIndex
})

describe('callParticipants', () => {
  it('marks a server-only user as joining and a tree user as secure', () => {
    const out = callParticipants(
      [vs('alice', 's-a'), vs('bob', 's-b')],
      [peer('bob')],
      [leaf('alice', 's-a', 0)]
    )
    expect(out.map((p) => [p.userId, p.status])).toEqual([
      ['alice', 'secure'],
      ['bob', 'joining']
    ])
    expect(out[0].voiceState?.sessionId).toBe('s-a')
    expect(out[1].leaves).toEqual([])
  })

  it('matches by session id: a leaf of an old session does not make the new session secure', () => {
    const out = callParticipants([vs('alice', 's-new')], [], [leaf('alice', 's-old', 3)])
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('joining')
    expect(out[0].leaves.map((l) => l.leafIndex)).toEqual([3])
  })

  it('matches a leaf without a session id by user id', () => {
    const out = callParticipants([vs('alice', 's-a')], [], [leaf('alice', '', 1)])
    expect(out[0].status).toBe('secure')
  })

  it('matches a media peer without a voice state by user id', () => {
    const out = callParticipants([], [peer('carol')], [leaf('carol', 's-c', 2)])
    expect(out).toEqual([
      { userId: 'carol', status: 'secure', voiceState: null, leaves: [leaf('carol', 's-c', 2)] }
    ])
  })

  it('shows a tree leaf that no server reports as leaving', () => {
    const out = callParticipants(
      [vs('alice', 's-a')],
      [],
      [leaf('alice', 's-a', 0), leaf('dave', 's-d', 1)]
    )
    expect(out.map((p) => [p.userId, p.status])).toEqual([
      ['alice', 'secure'],
      ['dave', 'leaving']
    ])
  })

  it('ignores roster entries without a leaf index', () => {
    const out = callParticipants([vs('alice', 's-a')], [], [leaf('alice', 's-a', null)])
    expect(out[0].status).toBe('joining')
  })

  it('lists each user once, with every leaf of the user', () => {
    const out = callParticipants(
      [vs('alice', 's-a')],
      [peer('alice')],
      [leaf('alice', 's-a', 0), leaf('alice', 's-x', 4)]
    )
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe('secure')
    expect(out[0].leaves.map((l) => l.leafIndex)).toEqual([0, 4])
  })

  it('gives an empty list for an empty call', () => {
    expect(callParticipants([], [], [])).toEqual([])
  })
})

describe('secureUserIds', () => {
  it('holds only users with a leaf and a server session', () => {
    const out = callParticipants(
      [vs('alice', 's-a'), vs('bob', 's-b')],
      [],
      [leaf('alice', 's-a', 0), leaf('dave', 's-d', 1)]
    )
    expect([...secureUserIds(out)]).toEqual(['alice'])
  })
})

describe('epochCodeGroups', () => {
  it('splits 30 digits into 6 groups of 5', () => {
    expect(epochCodeGroups('090600000100002000030000400005')).toEqual([
      '09060',
      '00001',
      '00002',
      '00003',
      '00004',
      '00005'
    ])
  })

  it('rejects anything that is not exactly 30 digits', () => {
    expect(epochCodeGroups(null)).toBeNull()
    expect(epochCodeGroups('')).toBeNull()
    expect(epochCodeGroups('1'.repeat(29))).toBeNull()
    expect(epochCodeGroups('1'.repeat(31))).toBeNull()
    expect(epochCodeGroups(`${'1'.repeat(29)}a`)).toBeNull()
    expect(epochCodeGroups(`12345 ${'1'.repeat(25)}`)).toBeNull()
  })
})
