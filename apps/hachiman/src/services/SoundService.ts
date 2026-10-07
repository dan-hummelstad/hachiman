import { play } from 'cuelume'
import type { SelfVoiceState, VoiceState } from '@hachiman/client'
import { isMuted, notifyLevel, shouldPing, type NotifyPrefs } from '@/lib/notify'
import type { ChatMessage } from '@/stores/messagesStore'
import { playChime } from '@/lib/chime'
import { SOUNDS, type SoundEvent } from '@/lib/sounds'
import type { ClientFeature } from '@/services/features'
import type { MessageContext } from '@/services/message-context'
import { notifyPrefs, usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** Plays `event` unless the user switched sounds off, or this one sound. */
export function playSound(event: SoundEvent): void {
  const { soundsEnabled, disabledSounds } = usePrefsStore.getState()
  if (soundsEnabled && !disabledSounds.includes(event)) previewSound(event)
}

/** Plays `event` whatever the switches say: the settings preview. */
export function previewSound(event: SoundEvent): void {
  const sound = SOUNDS[event]
  const volume = usePrefsStore.getState().soundVolume
  if ('cue' in sound) play(sound.cue, { ...sound.opts, volume })
  else playChime(sound, volume)
}

/**
 * Plays the sounds for other people's voice changes in my channel. `startHachiman()` calls it
 * once. A change of my own channel plays nothing here (VoiceService plays my join or leave).
 */
export function startSounds(): void {
  useVoiceStore.subscribe((s, p) => {
    const myChannelId = s.channelId
    if (!myChannelId || !s.guildId || s.voiceStates === p.voiceStates) return
    if (myChannelId !== p.channelId) return
    const before = p.voiceStates.get(s.guildId)
    const after = s.voiceStates.get(s.guildId)
    const meId = useUserStore.getState().me?.id
    for (const userId of new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])])) {
      if (userId === meId) continue
      const sound = voiceStateSound(before?.get(userId), after?.get(userId), myChannelId)
      // ponytail: one sound per update; a resync that moves many people plays only the first.
      if (sound) return playSound(sound)
    }
  })
}

const NO_NOTIFY_PREFS: NotifyPrefs = { notify: {}, muted: [] }

/**
 * Pings by the notification level of the channel (N9). The defaults are Discord's: a DM or a
 * mention of me pings. Only a decrypted chat row that is a notification (not mine, not blocked)
 * pings, and never while I am looking at that channel.
 */
export function messageSound(
  row: Pick<ChatMessage, 'guildId' | 'channelId' | 'decrypt' | 'kind'> | undefined,
  ctx: MessageContext,
  prefs: NotifyPrefs = NO_NOTIFY_PREFS
): SoundEvent | null {
  if (!row || !ctx.isNotification || ctx.viewing) return null
  if (row.decrypt.status !== 'ok' || row.kind === 'page_activity') return null
  const level = notifyLevel(prefs, row.channelId, row.guildId)
  const muted = isMuted(prefs, row.channelId, row.guildId)
  return shouldPing(level, muted, ctx.mentionsMe) ? 'message' : null
}

/** The message sound as a client feature. */
export const soundFeature: ClientFeature = {
  name: 'sound',
  onMessage(_m, row, ctx): void {
    const sound = messageSound(row, ctx, notifyPrefs())
    if (sound) playSound(sound)
  }
}

/** Another user's change, heard from inside `myChannelId`: join, leave, share start or stop. */
export function voiceStateSound(
  prev: VoiceState | undefined,
  next: VoiceState | undefined,
  myChannelId: string
): SoundEvent | null {
  const wasHere = prev?.channelId === myChannelId
  const isHere = next?.channelId === myChannelId
  if (!wasHere && isHere) return 'userJoin'
  if (wasHere && !isHere) return 'userLeave'
  if (!isHere || !!prev?.selfStream === !!next?.selfStream) return null
  return next?.selfStream ? 'userStreamStart' : 'userStreamStop'
}

/** My mute or deafen change. Deafen wins, so unmuting while deafened plays undeafen. */
export function selfVoiceSound(before: SelfVoiceState, after: SelfVoiceState): SoundEvent | null {
  if (before.selfDeaf !== after.selfDeaf) return after.selfDeaf ? 'deafen' : 'undeafen'
  if (before.ownMute !== after.ownMute) return after.ownMute ? 'mute' : 'unmute'
  return null
}
