import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
// import { devtools, persist } from 'zustand/middleware'
import { devtools } from 'zustand/middleware'

export type Channel = {
  id: number
  name: string
}

interface ChannelsState {
  channels: Map<string, Channel[]> // channels by server
  selectedChannelId: number | null
  setChannels: (server: string, channels: Channel[]) => void
  addChannel: (server: string, channel: Channel) => void
  updateChannel: (server: string, id: number, channel: Partial<Channel>) => void
  removeChannel: (server: string, id: number) => void
  clearChannels: () => void
  setSelectedChannelId: (id: number | null) => void
}

export const useChannelStore = create<ChannelsState>()(
  devtools(
    // persist(
    (set) => ({
      channels: new Map<string, Channel[]>(),
      selectedChannelId: null,
      setChannels: (server: string, channels: Channel[]) =>
        set((state) => {
          const newChannels = new Map(state.channels)
          newChannels.set(server, channels)
          return { channels: newChannels }
        }),
      addChannel: (server: string, channel: Channel) =>
        set((state) => {
          const newChannels = new Map(state.channels)
          if (!newChannels.has(server)) {
            newChannels.set(server, [])
          }
          const serverChannels = newChannels.get(server)!
          serverChannels.push(channel)
          newChannels.set(server, serverChannels)
          return { channels: newChannels }
        }),
      updateChannel: (server: string, id: number, channel: Partial<Channel>) =>
        set((state) => {
          const existingChannel = state.channels.get(server)?.find((c) => c.id === id)
          if (!existingChannel) {
            return {}
          }
          const updatedChannel = { ...existingChannel, ...channel }
          const newChannels = new Map(state.channels)
          const serverChannels = newChannels
            .get(server)!
            .map((c) => (c.id === id ? updatedChannel : c))
          newChannels.set(server, serverChannels)
          return { channels: newChannels }
        }),
      removeChannel: (server: string, id: string) =>
        set((state) => {
          const newChannels = new Map(state.channels)
          newChannels.delete(id)
          return { channels: newChannels }
        }),
      clearChannels: () => set({ channels: new Map<string, Channel[]>() }),
      setSelectedChannelId: (id: number | null) => set({ selectedChannelId: id })
    })
    // )
  )
)
