import { Channel } from '@renderer/stores/channelStore'
import { useChannelStore } from '@renderer/stores/channelStore'
import { serversService } from './ServersService'
import { Message, useMessageStore } from '@renderer/stores/messagesStore'
import { randomUUID } from 'crypto'

export class ChannelsService {
  private _channelListeners: Map<string, Set<number>> = new Map()
  private _audioContext: AudioContext | null = null

  async getChannelsForServer(url: string): Promise<Channel[]> {
    const channelStore = useChannelStore.getState()
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }

    const channels: Channel[] = server.channels.map((channel) => ({
      id: channel.id,
      name: channel.name ?? 'Unnamed Channel'
    }))

    channelStore.setChannels(url, channels)
    return channels
  }

  async moveClientToChannel(url: string, channelId: number): Promise<void> {
    const channelStore = useChannelStore.getState()
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }

    await server.moveToChannel(channelId)
    channelStore.setSelectedChannelId(channelId)
    this.listenToChannelMessages(url, channelId)
  }

  listenToAudioStream(url: string, audioOutput: HTMLAudioElement): void {
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }
    server.recieveAudioFrame((decoded: Buffer) => {
    })
  }

  stopAudioStream(): void {
    if (this._audioContext) {
      this._audioContext.close()
      this._audioContext = null
    }
  }

  async sendMessageToChannel(url: string, channelId: number, message: string): Promise<void> {
    const server = serversService.getServer(url)
    const messageStore = useMessageStore.getState()
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }

    const newMessage: Message = {
      id: randomUUID().toString(),
      author: server.clientSession?.toString() ?? 'Unknown',
      content: message,
      date: new Date(),
      avatar: '' // Placeholder, implement avatar fetching if needed
    }
    await server.sendTextMessage(message, [channelId])
    messageStore.addMessage(channelId, newMessage)
  }

  private listenToChannelMessages(url: string, channelId: number): void {
    if (!this._channelListeners.has(url)) {
      this._channelListeners.set(url, new Set())
    }
    const listenedChannels = this._channelListeners.get(url)!
    if (listenedChannels.has(channelId)) {
      return
    }
    const server = serversService.getServer(url)
    const messageStore = useMessageStore.getState()
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }

    server.on('textMessage', (msg) => {
      if (msg.channelIds && msg.channelIds.includes(channelId)) {
        const newMessage: Message = {
          id: randomUUID().toString(),
          author: msg.fromUserId?.toString() ?? 'Unknown',
          content: msg.message,
          date: new Date(),
          avatar: '' // Placeholder, implement avatar fetching if needed
        }
        messageStore.addMessage(channelId, newMessage)
      }
    })
    listenedChannels.add(channelId)
  }
}

export const channelsService = new ChannelsService()
