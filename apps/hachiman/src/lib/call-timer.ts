import type { VoiceState } from '@hachiman/client'

/**
 * When the call in a channel started (N17): the oldest `joinedAt` of its current participants,
 * in ms. Null with no participant that has a valid `joinedAt` (an older gateway sends none).
 */
export function callStartedAt(states: readonly Pick<VoiceState, 'joinedAt'>[]): number | null {
  let oldest: number | null = null
  for (const s of states) {
    const t = s.joinedAt ? Date.parse(s.joinedAt) : NaN
    if (Number.isNaN(t)) continue
    if (oldest === null || t < oldest) oldest = t
  }
  return oldest
}
