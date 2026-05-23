import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

interface UserState {
  username: string | null
  selfMute: boolean
  selfDeaf: boolean
  setUsername: (username: string) => void
  setSelfMute: (value: boolean) => void
  setSelfDeaf: (value: boolean) => void
}

export const useUserStore = create<UserState>()(
  devtools(
    persist(
      (set) => ({
        username: null,
        selfMute: false,
        selfDeaf: false,
        setUsername: (username: string | null) => set({ username }),
        setSelfMute: (value: boolean) => set({ selfMute: value }),
        setSelfDeaf: (value: boolean) => set({ selfDeaf: value })
      }),
      {
        name: 'hachiman-user-storage'
      }
    )
  )
)
