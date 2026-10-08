import { create } from 'zustand'
import type { User } from '@hachiman/client'

export interface PokeToast {
  id: number
  user: User
  at: number
}

/** At most this many toasts show; a new poke drops the oldest. */
const MAX_TOASTS = 3

interface PokeState {
  toasts: PokeToast[]
  add(t: PokeToast): void
  remove(id: number): void
}

/** The open poke toasts, oldest first. One toast per sender: a new poke replaces it. */
export const usePokeStore = create<PokeState>()((set) => ({
  toasts: [],
  add: (t) =>
    set((s) => ({
      toasts: [...s.toasts.filter((x) => x.user.id !== t.user.id), t].slice(-MAX_TOASTS)
    })),
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }))
}))
