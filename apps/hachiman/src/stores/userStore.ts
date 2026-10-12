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
  /** The user ids that I blocked (N23). Mirror of HachimanClient.cache.blocks. */
  blocks: ReadonlySet<string>
  /**
   * The blocked users from the last block list (blockService.load), for their names: a blocked
   * user I share no guild with is in no member list. Can lack a user blocked since.
   */
  blockedUsers: ReadonlyMap<string, User>
  /**
   * userId → when I blocked them (ISO), for "Blocked 3 Oct" (M34): from the block list, or the
   * time of the USER_BLOCK_UPDATE for a block since.
   */
  blockedAt: ReadonlyMap<string, string>
}

const initialUserState = (): Pick<
  UserState,
  'me' | 'status' | 'blocks' | 'blockedUsers' | 'blockedAt'
> => ({
  me: null,
  status: 'online',
  blocks: new Set(),
  blockedUsers: new Map(),
  blockedAt: new Map()
})

export const useUserStore = create<UserState>()(
  devtools(() => ({ ...initialUserState(), gatewayState: 'idle' }))
)

export function resetUserStore(): void {
  useUserStore.setState(initialUserState())
}

/** True when I blocked `userId`. */
export function isBlocked(userId: string): boolean {
  return useUserStore.getState().blocks.has(userId)
}

export function useIsBlocked(userId: string): boolean {
  return useUserStore((s) => s.blocks.has(userId))
}
