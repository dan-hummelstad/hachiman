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
   * When this row was last touched locally. Used for last-write-wins reconciliation
   * with the Oracle backend during sync.
   */
  updatedAt?: number
  /**
   * When the user most recently connected to this server. Pushed to Oracle on
   * connect success so other devices reflect "recently used" ordering.
   */
  lastUsedAt?: number
  /**
   * The server's voice region code (e.g. "us-east"). Forward-declared for
   * region-aware client code (Team B); NOT yet populated by the sync layer
   * today. Mirrors the Oracle `servers` registry's mutable, re-selectable region.
   */
  region?: string | null
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
            return { servers: newServers }
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
