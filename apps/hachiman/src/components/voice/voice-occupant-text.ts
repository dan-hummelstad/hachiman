import type { VoiceState } from '@hachiman/client'
import { joinNames } from '@/lib/channel-access'

/**
 * The detail line of a voice occupant row on the mobile layout (M64): what the person does in the
 * call, "Sharing screen · muted", "Server muted · deafened". Null when there is nothing to say.
 */
export function occupantDetail(
  state: Pick<VoiceState, 'selfStream' | 'selfMute' | 'selfDeaf' | 'mute' | 'deaf'>
): string | null {
  const parts: string[] = []
  if (state.selfStream) parts.push('sharing screen')
  if (state.mute) parts.push('server muted')
  else if (state.selfMute) parts.push('muted')
  if (state.deaf) parts.push('server deafened')
  else if (state.selfDeaf) parts.push('deafened')
  if (parts.length === 0) return null
  const text = parts.join(' · ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** At most this many names in the line; the rest is a count. */
const NAMED = 3

/**
 * The line under the live card of a voice channel I am not in (M64): the other people in the
 * call, "yuki.h, renata and tobias are in the call". Past three names, the first two and a count.
 * The mock says "are watching": who watches the stream is not known yet (spec section 5), only
 * who is in the call. Null when no one else is in it.
 */
export function othersInCallText(names: readonly string[]): string | null {
  if (names.length === 0) return null
  const shown =
    names.length > NAMED
      ? [...names.slice(0, NAMED - 1), `${names.length - (NAMED - 1)} others`]
      : [...names]
  return `${joinNames(shown)} ${names.length === 1 ? 'is' : 'are'} in the call`
}
