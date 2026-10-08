import type { CallRing, VoiceState } from '@hachiman/client'

/** How long a DM call rings (§6 "DM calls"). */
export const RING_MS = 30_000

/** An incoming DM call that rings on this device. */
export interface IncomingRing {
  channelId: string
  callerId: string
  /** ms: the ring stops then. */
  until: number
}

/**
 * The ring of a CALL_RING for `myId`, or null when it does not ring here: not for me, a blocked
 * caller, or older than RING_MS (a replay after RESUME). A gateway clock ahead of ours counts as
 * age 0.
 */
export function ringOf(
  d: CallRing,
  myId: string | null,
  blocked: ReadonlySet<string>,
  now: number
): IncomingRing | null {
  if (!myId || !d.ringing.includes(myId) || blocked.has(d.userId)) return null
  const at = Date.parse(d.at)
  const age = Number.isNaN(at) ? 0 : Math.max(0, now - at)
  if (age >= RING_MS) return null
  return { channelId: d.channelId, callerId: d.userId, until: now + RING_MS - age }
}

/**
 * Whether the ring goes on, from the voice states of the call (`states`: the DM call scope). It
 * stops when I am in the call (any device), when nobody is in it (the caller left), and in a 1:1
 * DM when the other person is in it with someone else (they answered elsewhere). The timeout and
 * a decline stop it outside this check.
 */
export function keepRinging(
  ring: IncomingRing,
  states: ReadonlyMap<string, VoiceState> | undefined,
  myId: string,
  myChannelId: string | null,
  oneToOne: boolean
): boolean {
  if (myChannelId === ring.channelId) return false
  const inCall = [...(states?.values() ?? [])].filter((vs) => vs.channelId === ring.channelId)
  if (inCall.length === 0) return false
  if (inCall.some((vs) => vs.userId === myId)) return false
  return !(oneToOne && inCall.some((vs) => vs.userId !== ring.callerId))
}
