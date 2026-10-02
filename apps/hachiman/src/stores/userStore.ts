import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { GatewayState, PresenceStatus, User } from '@hachiman/client'

interface UserState {
  /** The signed-in user as the gateway sees them (READY.user). */
  me: User | null
  /**
   * My own presence, as last chosen or echoed. Kept apart from guildStore.presences because that
   * mirror drops offline entries, which for me means "Invisible", not "unknown".
   */
  status: PresenceStatus
  /** Gateway connection state. Driven by the client's 'state' event, so a reset leaves it alone. */
  gatewayState: GatewayState
}

const initialUserState = (): Pick<UserState, 'me' | 'status'> => ({
  me: null,
  status: 'online'
})

export const useUserStore = create<UserState>()(
  devtools(() => ({ ...initialUserState(), gatewayState: 'idle' }))
)

export function resetUserStore(): void {
  useUserStore.setState(initialUserState())
}
