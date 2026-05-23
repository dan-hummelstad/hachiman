import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

interface VoiceState {
  micActive: boolean
  voiceConnected: boolean
  speakingUsers: Set<number>

  // Per-server: which channel the user is voice-connected to.
  // Independent of channelStore.selectedChannelByServer (the channel being viewed).
  voiceChannelByServer: Map<string, number>

  setMicActive: (active: boolean) => void
  setVoiceConnected: (connected: boolean) => void
  addSpeaking: (session: number) => void
  removeSpeaking: (session: number) => void
  setVoiceChannel: (server: string, channelId: number | null) => void
  getVoiceChannel: (server: string | null) => number | null
  reset: () => void
}

export const useVoiceStore = create<VoiceState>()(
  devtools((set, get) => ({
    micActive: false,
    voiceConnected: false,
    speakingUsers: new Set<number>(),
    voiceChannelByServer: new Map<string, number>(),

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
    reset: () =>
      set({
        micActive: false,
        voiceConnected: false,
        speakingUsers: new Set<number>(),
        voiceChannelByServer: new Map<string, number>()
      })
  }))
)
