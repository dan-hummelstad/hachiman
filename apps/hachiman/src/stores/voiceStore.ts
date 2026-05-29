import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import { EMPTY_CONNECTION_QUALITY, type ConnectionQuality } from '@/lib/connection-quality'

interface VoiceState {
  micActive: boolean
  voiceConnected: boolean
  speakingUsers: Set<number>

  // Per-server: which channel the user is voice-connected to.
  // Independent of channelStore.selectedChannelByServer (the channel being viewed).
  voiceChannelByServer: Map<string, number>

  // Client-side connection quality (RTT / jitter / packet-loss) for the active
  // session. Defaults to EMPTY_CONNECTION_QUALITY ("not yet measured"); the
  // voice-controls indicator renders an "unavailable" state until a producer
  // populates it (the Mumble client doesn't expose round-trip stats through
  // IMumbleService yet — see connection-quality.ts). A single typed slot so
  // the UI lights up with zero rework once stats flow.
  connectionQuality: ConnectionQuality

  setMicActive: (active: boolean) => void
  setVoiceConnected: (connected: boolean) => void
  addSpeaking: (session: number) => void
  removeSpeaking: (session: number) => void
  setVoiceChannel: (server: string, channelId: number | null) => void
  getVoiceChannel: (server: string | null) => number | null
  setConnectionQuality: (quality: ConnectionQuality) => void
  reset: () => void
}

export const useVoiceStore = create<VoiceState>()(
  devtools((set, get) => ({
    micActive: false,
    voiceConnected: false,
    speakingUsers: new Set<number>(),
    voiceChannelByServer: new Map<string, number>(),
    connectionQuality: EMPTY_CONNECTION_QUALITY,

    setMicActive: (active: boolean) => set({ micActive: active }),
    setVoiceConnected: (connected: boolean) => set({ voiceConnected: connected }),
    addSpeaking: (session: number) =>
      set((state) => {
        const next = new Set(state.speakingUsers)
        next.add(session)
        return { speakingUsers: next }
      }),
    removeSpeaking: (session: number) =>
      set((state) => {
        const next = new Set(state.speakingUsers)
        next.delete(session)
        return { speakingUsers: next }
      }),
    setVoiceChannel: (server: string, channelId: number | null) =>
      set((state) => {
        const next = new Map(state.voiceChannelByServer)
        if (channelId === null) {
          next.delete(server)
        } else {
          next.set(server, channelId)
        }
        return { voiceChannelByServer: next }
      }),
    getVoiceChannel: (server: string | null) => {
      if (!server) return null
      return get().voiceChannelByServer.get(server) ?? null
    },
    setConnectionQuality: (quality: ConnectionQuality) => set({ connectionQuality: quality }),
    reset: () =>
      set({
        micActive: false,
        voiceConnected: false,
        speakingUsers: new Set<number>(),
        voiceChannelByServer: new Map<string, number>(),
        connectionQuality: EMPTY_CONNECTION_QUALITY
      })
  }))
)
