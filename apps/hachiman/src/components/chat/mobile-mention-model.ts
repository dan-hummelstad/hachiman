import type { PresenceStatus } from '@hachiman/client'
import type { VoiceActivity } from '@/lib/member-activity'
import type { TriggerChar } from '@/lib/mention-complete'

// The pure model of the mobile suggestion list (M6) and of the keyboard over the transcript.

/** The head of the mobile suggestion list (M6): what it lists and where from. */
export function mentionScope(char: TriggerChar, guildName: string | null): string {
  if (char === ':') return 'Emoji'
  if (char === '#') return guildName ? `Channels · ${guildName}` : 'Channels'
  return guildName ? `Members · ${guildName}` : 'People here'
}

/** The second line of a member in the mobile suggestion list (M6). */
export interface MemberDetail {
  text: string
  /** voice: the voice ink with its icon. quiet: tertiary. danger: do not disturb. */
  tone: 'voice' | 'quiet' | 'danger'
  /** The voice icon: speaking (audio lines) or in a call (speaker). */
  icon: 'speaking' | 'voice' | null
}

const AWAY_LABEL: Partial<Record<PresenceStatus, string>> = {
  idle: 'Idle',
  dnd: 'Do not disturb'
}

/**
 * The voice activity of a member ("Speaking in Lounge", "In Lounge", "Idle · in Lounge" when
 * away), else the custom status, else idle or do not disturb. Online and offline say nothing,
 * as in the members drawer (A4).
 */
export function memberDetail(
  activity: VoiceActivity | null,
  status: PresenceStatus,
  customStatus: string | null | undefined
): MemberDetail | null {
  const away = AWAY_LABEL[status]
  if (activity) {
    const where = activity.otherGuildName
      ? `${activity.channelName} · ${activity.otherGuildName}`
      : activity.channelName
    if (away) return { text: `${away} · in ${where}`, tone: 'quiet', icon: null }
    return activity.speaking
      ? { text: `Speaking in ${where}`, tone: 'voice', icon: 'speaking' }
      : { text: `In ${where}`, tone: 'voice', icon: 'voice' }
  }
  if (customStatus) return { text: customStatus, tone: 'quiet', icon: null }
  if (away) return { text: away, tone: status === 'dnd' ? 'danger' : 'quiet', icon: null }
  return null
}

/** The gap between the mobile suggestion list and the composer, and the room kept above it. */
export const POPOVER_GAP = 6
const POPOVER_MARGIN = 8
/** Never shorter than the head and two rows, even when the transcript has less room. */
export const POPOVER_MIN = 132

/**
 * The max height of the mobile suggestion list: the room between the top of the transcript
 * (`limitTop`) and the top of the composer (`anchorTop`), both in viewport px.
 */
export function popoverMaxHeight(anchorTop: number, limitTop: number): number {
  return Math.max(POPOVER_MIN, Math.floor(anchorTop - limitTop - POPOVER_GAP - POPOVER_MARGIN))
}

/** A drag on the transcript this far down (px) closes the keyboard. */
export const KEYBOARD_DISMISS_DRAG = 12

export function dragClosesKeyboard(startY: number, y: number): boolean {
  return y - startY > KEYBOARD_DISMISS_DRAG
}
