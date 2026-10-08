import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { VoicePeer, VoiceState } from '@hachiman/client'
import { EMPTY_CONNECTION_QUALITY, type ConnectionQuality } from '@/lib/connection-quality'

export type VoiceConnectionState = RTCPeerConnectionState | 'idle'

interface VoiceStoreState {
  /** The single global voice session (one per user). null = not in voice. */
  guildId: string | null
  channelId: string | null
  /** When this client joined `channelId` (ms): the call timer's fallback without a joinedAt. */
  localJoinedAt: number | null
  connectionState: VoiceConnectionState
  micActive: boolean
  /** Mirror of `HachimanClient.selfVoice`. `ownMute` and `selfDeaf` persist; `selfMute` derives from them. */
  ownMute: boolean
  selfMute: boolean
  selfDeaf: boolean
  /** My own captured screen, for the local preview. null = not sharing. */
  localScreen: MediaStream | null
  /** userId → that peer's screen track from media. Shown while their voice state has `selfStream`. */
  screens: Map<string, MediaStream>
  /**
   * userIds whose live share I chose to watch ("Watch stream"). A remote share shows no video
   * until then. VoiceService drops a user when their share ends.
   */
  watching: Set<string>
  /** userIds currently speaking (remote via media WS, self via local VAD). */
  speaking: Set<string>
  peers: VoicePeer[]
  /** Everyone's voice states: guildId → userId → state. Mirror of HachimanClient.cache.voiceStates. */
  voiceStates: Map<string, Map<string, VoiceState>>
  connectionQuality: ConnectionQuality
  setSpeaking: (userId: string, speaking: boolean) => void
  /** Replace the roster and drop speakers no longer in it (except `keepUserId`, i.e. us). */
  setPeers: (peers: VoicePeer[], keepUserId: string | null) => void
  resetSession: () => void
}

const SESSION_DEFAULTS = {
  guildId: null,
  channelId: null,
  localJoinedAt: null,
  connectionState: 'idle' as VoiceConnectionState,
  micActive: false,
  localScreen: null,
  screens: new Map<string, MediaStream>(),
  watching: new Set<string>(),
  speaking: new Set<string>(),
  peers: [],
  connectionQuality: EMPTY_CONNECTION_QUALITY
}

/** The mirrored slice (everyone's voice states). The local session resets via `resetSession`. */
const initialVoiceMirrorState = (): Pick<VoiceStoreState, 'voiceStates'> => ({
  voiceStates: new Map()
})

export const useVoiceStore = create<VoiceStoreState>()(
  devtools(
    persist(
      (set) => ({
        ...SESSION_DEFAULTS,
        ownMute: false,
        selfMute: false,
        selfDeaf: false,
        ...initialVoiceMirrorState(),
        setSpeaking: (userId, speaking) =>
          set((s) => {
            if (s.speaking.has(userId) === speaking) return {}
            const next = new Set(s.speaking)
            if (speaking) next.add(userId)
            else next.delete(userId)
            return { speaking: next }
          }),
        // Media sends no speaking=false for someone who left, so the roster prunes them.
        setPeers: (peers, keepUserId) =>
          set((s) => {
            const keep = new Set(peers.map((p) => p.userId))
            if (keepUserId) keep.add(keepUserId)
            const speaking = [...s.speaking].filter((id) => keep.has(id))
            return speaking.length === s.speaking.size
              ? { peers }
              : { peers, speaking: new Set(speaking) }
          }),
        resetSession: () =>
          set({ ...SESSION_DEFAULTS, speaking: new Set(), screens: new Map(), watching: new Set() })
      }),
      {
        name: 'hachiman-voice-storage',
        partialize: (s) => ({ ownMute: s.ownMute, selfDeaf: s.selfDeaf })
      }
    )
  )
)

export function resetVoiceMirror(): void {
  useVoiceStore.setState(initialVoiceMirrorState())
}
