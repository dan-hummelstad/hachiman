import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * My server mute and deafen in the current call (§6 "Voice moderation"): I cannot lift them. From
 * my voice state, else my member, as `HachimanClient.serverVoice`.
 */
export function useServerVoice(): { mute: boolean; deaf: boolean } {
  const myId = useUserStore((s) => s.me?.id)
  const guildId = useVoiceStore((s) => s.guildId)
  const stateMute = useVoiceStore((s) =>
    guildId && myId ? s.voiceStates.get(guildId)?.get(myId)?.mute : undefined
  )
  const stateDeaf = useVoiceStore((s) =>
    guildId && myId ? s.voiceStates.get(guildId)?.get(myId)?.deaf : undefined
  )
  const memberMute = useGuildStore((s) =>
    guildId && myId ? s.members.get(guildId)?.get(myId)?.mute : undefined
  )
  const memberDeaf = useGuildStore((s) =>
    guildId && myId ? s.members.get(guildId)?.get(myId)?.deaf : undefined
  )
  return { mute: !!(stateMute ?? memberMute), deaf: !!(stateDeaf ?? memberDeaf) }
}
