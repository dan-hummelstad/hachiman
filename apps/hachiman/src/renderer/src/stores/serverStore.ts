import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
// import { devtools, persist } from 'zustand/middleware'
import { devtools } from 'zustand/middleware'

export type Server = {
  id: string // the server's address
  name: string // the server's display name
  port: number // the server's port
  connected: boolean // whether the client is connected to the server
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

export const useServerStore = create<ServersState>()(
  devtools(
    // persist(
      (set) => ({
        servers: new Map<string, Server>(),
        selectedServerId: null,
        addServer: (server: Server) =>
          set((state) => {
            const newServers = new Map(state.servers)
            newServers.set(server.id, server)
            return { servers: newServers }
          }),
        updateServer: (id: string, server: Partial<Server>) =>
          set((state) => {
            const existingServer = state.servers.get(id)
            if (!existingServer) return {}
            const updatedServer = { ...existingServer, ...server }
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
        setSelectedServerId: (id: string | null) => set({ selectedServerId: id }),
      }),
      // {
      //   name: 'hachiman-server-storage'
      // }
    // )
  )
)
