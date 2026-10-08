import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** My server mute and deafen in the current call (§6 "Voice moderation"): I cannot lift them. */
export function useServerVoice(): { mute: boolean; deaf: boolean } {
  const myId = useUserStore((s) => s.me?.id)
  const mute = useVoiceStore((s) =>
    s.guildId && myId ? !!s.voiceStates.get(s.guildId)?.get(myId)?.mute : false
  )
  const deaf = useVoiceStore((s) =>
    s.guildId && myId ? !!s.voiceStates.get(s.guildId)?.get(myId)?.deaf : false
  )
  return { mute, deaf }
}
