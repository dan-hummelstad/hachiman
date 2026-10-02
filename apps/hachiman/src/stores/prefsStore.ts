import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

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
  setTheme: (theme: Theme) => void
  setMessageDisplay: (messageDisplay: MessageDisplay) => void
  setInputDeviceId: (inputDeviceId: string | null) => void
  setOutputDeviceId: (outputDeviceId: string | null) => void
}

export const usePrefsStore = create<PrefsState>()(
  devtools(
    persist(
      (set) => ({
        theme: 'dark',
        messageDisplay: 'cozy',
        inputDeviceId: null,
        outputDeviceId: null,
        setTheme: (theme) => set({ theme }),
        setMessageDisplay: (messageDisplay) => set({ messageDisplay }),
        setInputDeviceId: (inputDeviceId) => set({ inputDeviceId }),
        setOutputDeviceId: (outputDeviceId) => set({ outputDeviceId })
      }),
      { name: 'hachiman-prefs-storage' }
    )
  )
)
