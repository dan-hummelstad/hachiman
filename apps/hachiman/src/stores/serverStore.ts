import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { createJSONStorage, devtools, persist } from 'zustand/middleware'

export type Server = {
  id: string // the server's address (or remote serverId for Oracle-registered servers)
  name: string // the server's display name
  port: number // the server's port
  connected: boolean // whether the client is connected to the server
  /**
   * Oracle-registered server UUID. Present when the user discovered the server
   * through Takusen / synced it from their Oracle profile. Used to mint
   * per-server tokens before connect.
   */
  serverId?: string
  /**
   * Mumble username used at connect time. Defaults to the Oracle handle when
   * `useOracle` is true, or whatever the user typed manually otherwise.
   * Notably set to "SuperUser" for self-hosted admin sessions.
   */
  username?: string
  /**
   * Whether subsequent reconnects should mint an Oracle per-server token and
   * use the Oracle handle as username. False means "manual" auth: use the
   * stored `username` verbatim and, if it's SuperUser, prompt for the password.
   * Undefined on legacy rows added before this flag existed → treated as
   * `true` if an Oracle session is available, else `false`.
   */
  useOracle?: boolean
  /**
   * When this row was last touched locally. Used for last-write-wins reconciliation
   * with the Oracle backend during sync.
   */
  updatedAt?: number
  /**
   * When the user most recently connected to this server. Pushed to Oracle on
   * connect success so other devices reflect "recently used" ordering.
   */
  lastUsedAt?: number
}

interface ServersState {
  servers: Map<string, Server>
  selectedServerId: string | null
  addServer: (server: Server) => void
  updateServer: (id: string, server: Partial<Server>) => void
  removeServer: (id: string) => void
  clearServers: () => void
  setSelectedServerId: (id: string | null) => void
}

/**
 * `connected` is intentionally not persisted — it's transient runtime state.
 * Re-hydration always starts with every server marked disconnected.
 */
function sanitizeForPersist(server: Server): Server {
  return { ...server, connected: false }
}

export const useServerStore = create<ServersState>()(
  devtools(
    persist(
      (set) => ({
        servers: new Map<string, Server>(),
        selectedServerId: null,
        addServer: (server: Server) =>
          set((state) => {
            const newServers = new Map(state.servers)
            newServers.set(server.id, { ...server, updatedAt: server.updatedAt ?? Date.now() })
            return { servers: newServers }
          }),
        updateServer: (id: string, server: Partial<Server>) =>
          set((state) => {
            const existingServer = state.servers.get(id)
            if (!existingServer) return {}
            const updatedServer = { ...existingServer, ...server, updatedAt: Date.now() }
            const newServers = new Map(state.servers)
            newServers.set(id, updatedServer)
            return { servers: newServers }
          }),
        removeServer: (id: string) =>
          set((state) => {
            const newServers = new Map(state.servers)
            newServers.delete(id)
            // If the removed server was the active one, pick the next remaining
            // server (insertion order) so the UI doesn't stay frozen on a dead
            // id. Falls through to null when no servers remain, which the App
            // shell renders as the welcome / empty state.
            let nextSelected = state.selectedServerId
            if (nextSelected === id) {
              const remaining = newServers.keys().next()
              nextSelected = remaining.done ? null : remaining.value
            }
            return { servers: newServers, selectedServerId: nextSelected }
          }),
        clearServers: () => set({ servers: new Map<string, Server>() }),
        setSelectedServerId: (id: string | null) => set({ selectedServerId: id })
      }),
      {
        name: 'hachiman-server-storage',
        // Map is not JSON-serializable; round-trip through entries arrays.
        storage: createJSONStorage(() => localStorage, {
          replacer: (_key, value) => {
            if (value instanceof Map) {
              return {
                __type: 'Map',
                value: Array.from(value.entries()).map(([k, v]) => [
                  k,
                  sanitizeForPersist(v as Server)
                ])
              }
            }
            return value
          },
          reviver: (_key, value) => {
            if (
              value !== null &&
              typeof value === 'object' &&
              (value as { __type?: string }).__type === 'Map'
            ) {
              return new Map((value as { value: Array<[string, Server]> }).value)
            }
            return value
          }
        }),
        // We don't want to persist the runtime selection across reloads if there's
        // no guarantee that server still exists; let the app decide on mount.
        partialize: (state) => ({ servers: state.servers })
      }
    )
  )
)
