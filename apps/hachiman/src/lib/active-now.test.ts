import { describe, expect, it } from 'vitest'
import type { Channel, Guild, VoiceState } from '@hachiman/client'
import { activeCalls } from './active-now'

const guild = (id: string, name: string): Guild =>
  ({ id, name, icon: null, banner: null, ownerId: 'o', region: null }) as Guild
const channel = (id: string, guildId: string, name: string): Channel =>
  ({ id, guildId, type: 'voice', name }) as Channel
const vs = (
  guildId: string,
  channelId: string | null,
  userId: string,
  extra: Partial<VoiceState> = {}
): VoiceState => ({
  guildId,
  channelId,
  userId,
  sessionId: `s-${userId}`,
  selfMute: false,
  selfDeaf: false,
  selfStream: false,
  ...extra
})
const states = (...list: VoiceState[]): Map<string, Map<string, VoiceState>> => {
  const out = new Map<string, Map<string, VoiceState>>()
  for (const s of list) {
    const key = s.guildId ?? s.channelId ?? ''
    const g = out.get(key) ?? new Map<string, VoiceState>()
    g.set(s.userId, s)
    out.set(key, g)
  }
  return out
}

const guilds = new Map([
  ['g1', guild('g1', 'Night Owls')],
  ['g2', guild('g2', 'Lattice Labs')]
])
const channels = new Map([
  ['lounge', channel('lounge', 'g1', 'Lounge')],
  ['ranked', channel('ranked', 'g1', 'Ranked queue')],
  ['pairing', channel('pairing', 'g2', 'Pairing')],
  ['solo', channel('solo', 'g2', 'Solo')]
])

describe('activeCalls', () => {
  it('groups voice states by channel across guilds, my call first, then live, then size', () => {
    const calls = activeCalls(
      states(
        vs('g2', 'pairing', 'yuki'),
        vs('g2', 'pairing', 'renata'),
        vs('g2', 'pairing', 'petra'),
        vs('g1', 'ranked', 'quill', { selfStream: true }),
        vs('g1', 'lounge', 'marlowe'),
        vs('g1', 'lounge', 'me')
      ),
      channels,
      guilds,
      'me',
      'lounge'
    )
    expect(calls.map((c) => c.channelId)).toEqual(['lounge', 'ranked', 'pairing'])
    expect(calls[0]).toMatchObject({ withMe: true, guildName: 'Night Owls', streamerId: null })
    expect(calls[1]).toMatchObject({ streamerId: 'quill', channelName: 'Ranked queue' })
    expect(calls[2].userIds).toEqual(['yuki', 'renata', 'petra'])
  })

  it('orders people by join time and skips states without a channel', () => {
    const calls = activeCalls(
      states(
        vs('g1', 'lounge', 'b', { joinedAt: '2026-10-07T10:05:00Z' }),
        vs('g1', 'lounge', 'a', { joinedAt: '2026-10-07T10:00:00Z' }),
        vs('g1', null, 'c')
      ),
      channels,
      guilds,
      'me',
      null
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].userIds).toEqual(['a', 'b'])
  })

  it('leaves out unknown channels and a stale call with only me in it', () => {
    const calls = activeCalls(
      states(vs('g2', 'solo', 'me'), vs('g1', 'gone', 'x')),
      channels,
      guilds,
      'me',
      null
    )
    expect(calls).toEqual([])
  })

  it('does not name me as the streamer', () => {
    const [call] = activeCalls(
      states(vs('g1', 'lounge', 'me', { selfStream: true }), vs('g1', 'lounge', 'x')),
      channels,
      guilds,
      'me',
      'lounge'
    )
    expect(call.streamerId).toBeNull()
  })
})
