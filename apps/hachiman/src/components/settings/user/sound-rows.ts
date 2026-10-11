import type { SoundEvent } from '@/lib/sounds'

/** One switch of the mobile sound list (M32): one event, or a pair that goes on and off together. */
export interface SoundRow {
  label: string
  /** Short text after the label (12/500). */
  hint?: string
  /** The first event is the one that the play button previews. */
  events: readonly [SoundEvent, ...SoundEvent[]]
}

/** The mobile sound list: each sound and its opposite (mute and unmute) share one switch. */
export const SOUND_ROWS: readonly SoundRow[] = [
  { label: 'Message received', hint: 'DMs and mentions', events: ['message'] },
  { label: 'Message sent', events: ['messageSent'] },
  { label: 'You join or leave voice', events: ['voiceJoin', 'voiceLeave'] },
  { label: 'Voice disconnected', events: ['voiceDisconnect'] },
  { label: 'Someone joins or leaves', hint: 'Your channel', events: ['userJoin', 'userLeave'] },
  { label: 'Mute and unmute', events: ['mute', 'unmute'] },
  { label: 'Deafen and undeafen', events: ['deafen', 'undeafen'] },
  { label: 'You start or stop sharing', events: ['streamStart', 'streamStop'] },
  { label: 'Someone starts or stops sharing', events: ['userStreamStart', 'userStreamStop'] },
  { label: 'Someone pokes you', events: ['poke'] },
  { label: 'Incoming call', events: ['ring'] }
]

/** On only while every event of the row is on, so a tap on a half-on row turns all of it on. */
export function soundRowOn(row: SoundRow, disabled: readonly SoundEvent[]): boolean {
  return row.events.every((e) => !disabled.includes(e))
}
