import { Channel } from '@/stores/channelStore'
import { useChannelStore } from '@/stores/channelStore'
import { serversService } from './ServersService'
import { voiceService } from './VoiceService'
import { Message, useMessageStore } from '@/stores/messagesStore'

// Use the Web Crypto API (available in modern browsers and Node 19+ globalThis)
// so this module is portable between the Electron renderer and a plain browser build.
const randomUUID = (): string => globalThis.crypto.randomUUID()

export class ChannelsService {
  private _channelListeners: Map<string, Set<number>> = new Map()

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

  /**
   * Select a channel for viewing (text + members). Does NOT move the
   * Mumble user into the channel — that is what `joinVoiceChannel` is for.
   */
  selectChannel(url: string, channelId: number): void {
    const channelStore = useChannelStore.getState()
    channelStore.setSelectedChannelId(url, channelId)
    // Make sure we receive any new text messages broadcast to this channel.
    this.listenToChannelMessages(url, channelId)
  }

  /**
   * Join voice for the given channel. Moves the Mumble user into the channel
   * and starts the microphone. This is independent of which channel the user
   * is currently *viewing* (see selectChannel).
   */
  async joinVoiceChannel(url: string, channelId: number): Promise<void> {
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }

    await server.moveToChannel(channelId)
    // Keep listening for text messages on the voice channel too.
    this.listenToChannelMessages(url, channelId)
    await voiceService.joinVoice(url, channelId)
  }

  /**
   * Leave voice on the given server. Stops the microphone. The Mumble server
   * doesn't really have a "leave channel" concept (users are always in some
   * channel), so we just stop voice locally.
   */
  async leaveVoiceChannel(url: string): Promise<void> {
    await voiceService.leaveVoice(url)
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
      avatar: ''
    }
    // Eager-add so the sender sees their message immediately, before the
    // server round-trip. If the send fails, roll it back so the UI doesn't
    // claim a delivery that never happened.
    messageStore.addMessage(channelId, newMessage)
    try {
      await server.sendTextMessage(message, [channelId])
    } catch (err) {
      messageStore.deleteMessage(channelId, newMessage.id)
      throw err
    }
  }

  /**
   * Convenience: send a text message to the channel the user is currently
   * viewing on the given server. The server allows this without the user
   * actually being in that channel (Mumble's TextMessagePermission).
   */
  async sendTextMessage(url: string, text: string): Promise<void> {
    const channelStore = useChannelStore.getState()
    const channelId = channelStore.getSelectedChannelId(url)
    if (channelId === null) {
      throw new Error('No channel selected for text message')
    }
    await this.sendMessageToChannel(url, channelId, text)
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
