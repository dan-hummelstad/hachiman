import type { PlayOptions, SoundName } from 'cuelume'
import type { Chime } from '@/lib/chime'

export type SoundEvent =
  | 'message'
  | 'messageSent'
  | 'voiceJoin'
  | 'voiceLeave'
  | 'voiceDisconnect'
  | 'userJoin'
  | 'userLeave'
  | 'mute'
  | 'unmute'
  | 'deafen'
  | 'undeafen'
  | 'streamStart'
  | 'streamStop'
  | 'userStreamStart'
  | 'userStreamStop'
  | 'poke'
  | 'ring'

/** A Cuelume cue (messages) or one of our own chimes (voice). */
export type Sound = { cue: SoundName; opts?: PlayOptions } | Chime

// Equal-tempered note frequencies, in Hz.
const A3 = 220
const C4 = 261.63
const E4 = 329.63
const A4 = 440
const C5 = 523.25
const E5 = 659.25
const G5 = 783.99
const A5 = 880
const B5 = 987.77
const C6 = 1046.5

/** Notes `step` seconds apart. */
const seq = (step: number, ...hz: number[]): Chime['notes'] => hz.map((f, i) => [f, i * step])

/**
 * Discord-like sounds. Voice events are soft bell chimes: rising for on/join, the same notes
 * falling for off/leave, and my own actions louder than other people's. An arriving message uses
 * a Cuelume glass note. A sent message gets only a short, quiet high tick.
 */
export const SOUNDS: Record<SoundEvent, Sound> = {
  message: { cue: 'ready' },
  messageSent: { notes: [[C6, 0]], decay: 0.08, gain: 0.3 },
  voiceJoin: { notes: seq(0.1, E5, A5) },
  voiceLeave: { notes: seq(0.1, A5, E5) },
  voiceDisconnect: { notes: seq(0.14, E4, C4, A3), decay: 0.55 },
  userJoin: { notes: seq(0.09, C5, G5), gain: 0.7 },
  userLeave: { notes: seq(0.09, G5, C5), gain: 0.7 },
  mute: { notes: seq(0.06, A4, E4), decay: 0.2 },
  unmute: { notes: seq(0.06, E4, A4), decay: 0.2 },
  deafen: { notes: seq(0.07, E4, C4, A3), decay: 0.25 },
  undeafen: { notes: seq(0.07, A3, C4, E4), decay: 0.25 },
  streamStart: { notes: seq(0.07, C5, E5, G5, C6) },
  streamStop: { notes: seq(0.07, C6, G5, E5, C5) },
  userStreamStart: { notes: seq(0.07, E5, G5, B5), gain: 0.7 },
  userStreamStop: { notes: seq(0.07, B5, G5, E5), gain: 0.7 },
  // A playful hop: up a sixth and straight back, short and bright.
  poke: { notes: [[E5, 0], [C6, 0.08], [E5, 0.2]], decay: 0.18, gain: 0.9 },
  /** An incoming DM call. CallRingService repeats it while the call rings. */
  ring: { notes: seq(0.16, E5, G5, E5, G5), decay: 0.5, gain: 0.9 }
}

export const SOUND_EVENTS = Object.keys(SOUNDS) as SoundEvent[]
