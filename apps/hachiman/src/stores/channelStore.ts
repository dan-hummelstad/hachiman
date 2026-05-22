import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'

export type Channel = {
  id: number
  name: string
}

interface ChannelsState {
  channels: Map<string, Channel[]> // channels by server
  // Per-server selected channel (the one the user is viewing — text + member list).
  // Independent of the voice-connected channel (see voiceStore).
  selectedChannelByServer: Map<string, number>
  setChannels: (server: string, channels: Channel[]) => void
  addChannel: (server: string, channel: Channel) => void
  updateChannel: (server: string, id: number, channel: Partial<Channel>) => void
  removeChannel: (server: string, id: number) => void
  clearChannels: () => void
  setSelectedChannelId: (server: string, id: number | null) => void
  getSelectedChannelId: (server: string | null) => number | null
}

export const useChannelStore = create<ChannelsState>()(
  devtools((set, get) => ({
    channels: new Map<string, Channel[]>(),
    selectedChannelByServer: new Map<string, number>(),
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
    removeChannel: (server: string, id: number) =>
      set((state) => {
        const newChannels = new Map(state.channels)
        const serverChannels = newChannels.get(server)
        if (!serverChannels) return {}
        newChannels.set(
          server,
          serverChannels.filter((c) => c.id !== id)
        )
        return { channels: newChannels }
      }),
    clearChannels: () =>
      set({
        channels: new Map<string, Channel[]>(),
        selectedChannelByServer: new Map<string, number>()
      }),
    setSelectedChannelId: (server: string, id: number | null) =>
      set((state) => {
        const next = new Map(state.selectedChannelByServer)
        if (id === null) {
          next.delete(server)
        } else {
          next.set(server, id)
        }
        return { selectedChannelByServer: next }
      }),
    getSelectedChannelId: (server: string | null) => {
      if (!server) return null
      return get().selectedChannelByServer.get(server) ?? null
    }
  }))
)
