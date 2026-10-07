import { play } from 'cuelume'
import type { SelfVoiceState, User, VoiceState } from '@hachiman/client'
import { messageMentionsMe } from '@/lib/mentions'
import { isMuted, notifyLevel, shouldPing, type NotifyPrefs } from '@/lib/notify'
import type { ChatMessage } from '@/stores/messagesStore'
import { playChime } from '@/lib/chime'
import { SOUNDS, type SoundEvent } from '@/lib/sounds'
import { usePrefsStore } from '@/stores/prefsStore'
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
 * mention of me pings. Never while I am looking at that channel; my own messages never ping.
 */
export function messageSound(
  m: Pick<ChatMessage, 'author' | 'guildId' | 'channelId' | 'content' | 'mentions'>,
  me: Pick<User, 'id' | 'username'>,
  viewing: boolean,
  myRoleIds: readonly string[] = [],
  prefs: NotifyPrefs = NO_NOTIFY_PREFS
): SoundEvent | null {
  if (m.author.id === me.id || viewing) return null
  const level = notifyLevel(prefs, m.channelId, m.guildId)
  const muted = isMuted(prefs, m.channelId, m.guildId)
  return shouldPing(level, muted, messageMentionsMe(m, me, myRoleIds)) ? 'message' : null
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
