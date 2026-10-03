import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'
import type { StreamQuality } from '@/lib/stream-quality'
import type { SoundEvent } from '@/lib/sounds'

export type MessageDisplay = 'cozy' | 'compact'
/** `system` follows the OS colour scheme. Applied to `<html>` by `ThemeProvider`. */
export type Theme = 'dark' | 'light' | 'system'

/** Local, per-device UI preferences. Written by the user settings overlay. */
interface PrefsState {
  theme: Theme
  messageDisplay: MessageDisplay
  /** `MediaDeviceInfo.deviceId`; null = the system default. */
  inputDeviceId: string | null
  outputDeviceId: string | null
  /** Screen share capture and send quality. Applies to a live share too. */
  streamQuality: StreamQuality
  /** Notification and voice sounds (SoundService). */
  soundsEnabled: boolean
  /** 0..1 */
  soundVolume: number
  /** Sounds the user switched off one by one. Ignored while `soundsEnabled` is false. */
  disabledSounds: SoundEvent[]
  /** Width of the pages panel per pages channel, in percent of the split; 0 = collapsed. */
  pagesPanelSize: Record<string, number>
  setTheme: (theme: Theme) => void
  setMessageDisplay: (messageDisplay: MessageDisplay) => void
  setInputDeviceId: (inputDeviceId: string | null) => void
  setOutputDeviceId: (outputDeviceId: string | null) => void
  setStreamQuality: (streamQuality: StreamQuality) => void
  setSoundsEnabled: (soundsEnabled: boolean) => void
  setSoundVolume: (soundVolume: number) => void
  setSoundEnabled: (event: SoundEvent, enabled: boolean) => void
  setPagesPanelSize: (channelId: string, size: number) => void
}

export const usePrefsStore = create<PrefsState>()(
  devtools(
    persist(
      (set) => ({
        theme: 'dark',
        messageDisplay: 'cozy',
        inputDeviceId: null,
        outputDeviceId: null,
        streamQuality: { resolution: '1080p', fps: 30 },
        soundsEnabled: true,
        soundVolume: 0.7,
        disabledSounds: [],
        pagesPanelSize: {},
        setTheme: (theme) => set({ theme }),
        setMessageDisplay: (messageDisplay) => set({ messageDisplay }),
        setInputDeviceId: (inputDeviceId) => set({ inputDeviceId }),
        setOutputDeviceId: (outputDeviceId) => set({ outputDeviceId }),
        setStreamQuality: (streamQuality) => set({ streamQuality }),
        setSoundsEnabled: (soundsEnabled) => set({ soundsEnabled }),
        setSoundVolume: (soundVolume) => set({ soundVolume }),
        setSoundEnabled: (event, enabled) =>
          set((s) => ({
            disabledSounds: enabled
              ? s.disabledSounds.filter((e) => e !== event)
              : [...new Set([...s.disabledSounds, event])]
          })),
        setPagesPanelSize: (channelId, size) =>
          set((s) =>
            s.pagesPanelSize[channelId] === size
              ? s
              : { pagesPanelSize: { ...s.pagesPanelSize, [channelId]: size } }
          )
      }),
      { name: 'hachiman-prefs-storage' }
    )
  )
)
