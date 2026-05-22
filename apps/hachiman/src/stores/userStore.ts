import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

interface UserState {
  username: string | null
  setUsername: (username: string) => void
}

export const useUserStore = create<UserState>()(
  devtools(
    persist(
      (set) => ({
        username: null,
        setUsername: (username: string | null) => set({ username })
      }),
      {
        name: 'hachiman-user-storage'
      }
    )
  )
)
