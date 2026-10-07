import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { voiceActivity, type VoiceActivity } from '@/lib/member-activity'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** The voice activity of `userId` (lib/member-activity.ts), from the voice, channel and guild stores. */
export function useVoiceActivity(
  userId: string,
  contextGuildId: string | null
): VoiceActivity | null {
  const { voiceStates, speaking, myChannelId } = useVoiceStore(
    useShallow((s) => ({
      voiceStates: s.voiceStates,
      speaking: s.speaking,
      myChannelId: s.channelId
    }))
  )
  const channels = useChannelStore((s) => s.channels)
  const guilds = useGuildStore((s) => s.guilds)
  return useMemo(
    () =>
      voiceActivity(userId, contextGuildId, {
        voiceStates,
        channels,
        guilds,
        speaking,
        myChannelId
      }),
    [userId, contextGuildId, voiceStates, channels, guilds, speaking, myChannelId]
  )
}

/** `Date.now()`, renewed every `intervalMs` while `active`. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
  return now
}
