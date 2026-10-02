import type {} from '@redux-devtools/extension'
import { create } from 'zustand'
import { devtools } from 'zustand/middleware'
import type { Channel } from '@hachiman/client'

/** Mirror of HachimanClient.cache.channels (guild channels + DMs). Written only by services/hachiman.ts. */
interface ChannelState {
  channels: Map<string, Channel>
}

const initialChannelState = (): ChannelState => ({ channels: new Map() })

export const useChannelStore = create<ChannelState>()(devtools(initialChannelState))

export function resetChannelStore(): void {
  useChannelStore.setState(initialChannelState())
}
