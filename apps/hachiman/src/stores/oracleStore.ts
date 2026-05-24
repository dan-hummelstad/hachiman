import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools, persist } from 'zustand/middleware'

export interface OracleUser {
  id: string
  handle: string
  email: string
}

export interface OracleSession {
  accessToken: string
  refreshToken: string | null
  expiresAt: number // unix ms
  user: OracleUser
}

interface PKCEFlowState {
  state: string
  codeVerifier: string
  nonce: string
  redirectUri: string
  createdAt: number
}

interface OracleState {
  session: OracleSession | null
  /**
   * Pending PKCE state set when the user kicks off sign-in. Cleared once the
   * authorization callback exchanges the code for tokens (or expires).
   */
  pendingFlow: PKCEFlowState | null
  setSession: (session: OracleSession | null) => void
  setPendingFlow: (flow: PKCEFlowState | null) => void
  clearSession: () => void
}

export const useOracleStore = create<OracleState>()(
  devtools(
    persist(
      (set) => ({
        session: null,
        pendingFlow: null,
        setSession: (session) => set({ session }),
        setPendingFlow: (pendingFlow) => set({ pendingFlow }),
        clearSession: () => set({ session: null, pendingFlow: null })
      }),
      {
        name: 'hachiman-oracle-storage',
        // We intentionally persist `pendingFlow` so the PKCE handshake can
        // survive a window close between authorize-redirect and callback.
        // Sessions older than 24h with no resolution are stale; the OracleService
        // discards them on rehydrate.
        partialize: (state) => ({ session: state.session, pendingFlow: state.pendingFlow })
      }
    )
  )
)
