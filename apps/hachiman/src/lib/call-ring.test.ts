import { describe, expect, it } from 'vitest'
import type { VoiceState } from '@hachiman/client'
import { RING_MS, keepRinging, ringOf, type IncomingRing } from '@/lib/call-ring'

const AT = Date.parse('2026-10-08T12:00:00Z')
const ring = { channelId: 'dm', userId: 'caller', ringing: ['me'], at: '2026-10-08T12:00:00Z' }

const vs = (userId: string, channelId: string | null = 'dm'): VoiceState => ({
  guildId: null,
  channelId,
  userId,
  sessionId: `s-${userId}`,
  selfMute: false,
  selfDeaf: false,
  selfStream: false
})
const states = (...list: VoiceState[]): Map<string, VoiceState> =>
  new Map(list.map((s) => [s.userId, s]))

describe('ringOf', () => {
  it('rings the users in `ringing` for the rest of 30 s', () => {
    expect(ringOf(ring, 'me', new Set(), AT + 1_000)).toEqual({
      channelId: 'dm',
      callerId: 'caller',
      until: AT + RING_MS
    })
  })

  it('does not ring for others, blocked callers or an old ring', () => {
    expect(ringOf(ring, 'other', new Set(), AT)).toBeNull()
    expect(ringOf(ring, null, new Set(), AT)).toBeNull()
    expect(ringOf(ring, 'me', new Set(['caller']), AT)).toBeNull()
    expect(ringOf(ring, 'me', new Set(), AT + RING_MS)).toBeNull()
  })

  it('treats a gateway clock ahead of ours as a fresh ring', () => {
    expect(ringOf(ring, 'me', new Set(), AT - 5_000)?.until).toBe(AT - 5_000 + RING_MS)
  })
})

describe('keepRinging', () => {
  const r: IncomingRing = { channelId: 'dm', callerId: 'caller', until: AT + RING_MS }

  it('rings while the caller waits', () => {
    expect(keepRinging(r, states(vs('caller')), 'me', null, true)).toBe(true)
  })

  it('stops when the caller leaves or nobody is left', () => {
    expect(keepRinging(r, states(vs('caller', null)), 'me', null, true)).toBe(false)
    expect(keepRinging(r, undefined, 'me', null, true)).toBe(false)
  })

  it('stops when I join, from this or another device', () => {
    expect(keepRinging(r, states(vs('caller'), vs('me')), 'me', null, true)).toBe(false)
    expect(keepRinging(r, states(vs('caller')), 'me', 'dm', true)).toBe(false)
  })

  it('in a group DM, rings on while others join', () => {
    expect(keepRinging(r, states(vs('caller'), vs('carol')), 'me', null, false)).toBe(true)
    expect(keepRinging(r, states(vs('caller'), vs('carol')), 'me', null, true)).toBe(false)
  })
})
