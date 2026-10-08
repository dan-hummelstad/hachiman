import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export interface TakusenUser {
  id: string
  handle: string
  email: string
}

export interface TakusenSession {
  accessToken: string
  refreshToken: string | null
  expiresAt: number // unix ms
  user: TakusenUser
}

interface PKCEFlowState {
  state: string
  codeVerifier: string
  redirectUri: string
  /** Invite the sign-in started from; reopened after the callback. */
  inviteCode: string | null
  createdAt: number
}

interface TakusenState {
  session: TakusenSession | null
  /**
   * Pending PKCE state set when the user kicks off sign-in. Cleared once the
   * authorization callback exchanges the code for tokens (or expires).
   */
  pendingFlow: PKCEFlowState | null
  /** Why the last OAuth callback failed; cleared when a new sign-in starts. Not persisted. */
  authError: string | null
  setSession: (session: TakusenSession | null) => void
  setPendingFlow: (flow: PKCEFlowState | null) => void
  setAuthError: (authError: string | null) => void
  clearSession: () => void
}

/** The localStorage key of the persisted sign-in. "Clear cached data" keeps it. */
export const TAKUSEN_STORAGE_KEY = 'hachiman-takusen-storage'

export const useTakusenStore = create<TakusenState>()(
  devtools(
    persist(
      (set) => ({
        session: null,
        pendingFlow: null,
        authError: null,
        setSession: (session) => set({ session }),
        setPendingFlow: (pendingFlow) => set({ pendingFlow }),
        setAuthError: (authError) => set({ authError }),
        clearSession: () => set({ session: null, pendingFlow: null })
      }),
      {
        name: TAKUSEN_STORAGE_KEY,
        // `pendingFlow` is persisted so the PKCE handshake survives the browser's
        // same-tab redirect and an Electron restart between authorize and callback.
        partialize: (state) => ({ session: state.session, pendingFlow: state.pendingFlow })
      }
    )
  )
)
