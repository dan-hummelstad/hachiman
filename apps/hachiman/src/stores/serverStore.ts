import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { createJSONStorage, devtools, persist } from 'zustand/middleware'

import { deriveServerId } from '@/lib/server-key'

export type Server = {
  /**
   * Stable identity key — what the Map is keyed on, what the UI passes around
   * as `serverId`/`selectedServerId`, what the connection manager indexes by.
   *
   * Two regimes:
   *   - Oracle-registered (managed) servers: equal to the Takusen `serverId`
   *     (server-side UUID). Lets multiple managed vServers on the SAME
   *     gateway host coexist — one host can front-door many in-process
   *     vServers, so host alone is no longer unique.
   *   - Self-hosted servers: composite `${host}:${port}`. Lets the user run
   *     multiple local dev servers on the same host, while still preventing
   *     a duplicate add of the same address.
   *
   * Use {@link deriveServerId} (lib/server-key.ts) to compute this from a
   * partial record; never set it by hand.
   */
  id: string
  name: string // the server's display name
  /**
   * The actual network address the client connects to. Previously implicit
   * in `id` (when id was just the host); now stored explicitly because
   * `id` may be a UUID instead.
   */
  host: string
  port: number // the server's port
  connected: boolean // whether the client is connected to the server
  /**
   * Oracle-registered server UUID. Present when the user discovered the server
   * through Takusen / synced it from their Oracle profile. Used to mint
   * per-server tokens before connect, AND used as the keying `id` above.
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
   * use the Oracle handle as username. Mutually exclusive with `superUser`:
   * one of the two MUST be true on every persisted row — anonymous joins are
   * no longer supported, so a row with neither flag set is a legacy/invalid
   * entry the user is asked to re-add.
   */
  useOracle?: boolean
  /**
   * Self-hosted SuperUser entry. Username is implicitly "SuperUser"; the
   * password is never persisted, so on every fresh connect (including app
   * relaunch) the user has to re-enter it via {@link SuperUserPasswordDialog}.
   * Mutually exclusive with `useOracle`.
   */
  superUser?: boolean
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
              // One-time migration of pre-host-aware rows:
              //   Old shape:  id === host (no `host` field on the record;
              //               `serverId` may or may not be set).
              //   New shape:  id === deriveServerId({serverId, host, port});
              //               `host` always set explicitly.
              // Re-key entries whose stored id doesn't match the derived id
              // and backfill `host` from the legacy id when absent. Done at
              // hydration time so the rest of the app never sees the old
              // shape.
              const entries = (value as { value: Array<[string, Server]> }).value
              const migrated = new Map<string, Server>()
              for (const [storedKey, raw] of entries) {
                const host =
                  typeof raw.host === 'string' && raw.host.length > 0 ? raw.host : storedKey
                const id = deriveServerId({
                  serverId: raw.serverId,
                  host,
                  port: raw.port
                })
                migrated.set(id, { ...raw, id, host })
              }
              return migrated
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
