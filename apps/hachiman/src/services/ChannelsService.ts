import { Channel, ChannelType } from '@/stores/channelStore'
import { useChannelStore } from '@/stores/channelStore'
import { serversService } from './ServersService'
import { voiceService } from './VoiceService'
import { useMessageStore, type Message } from '@/stores/messagesStore'
import { ChannelState_ChannelType } from '@hachiman/hachiman-node'
import type { Channel as MumbleChannel } from '@hachiman/hachiman-node'
import type { IMumbleService } from '@/shared/IMumbleService'

function toUiChannel(channel: MumbleChannel): Channel {
  return {
    id: channel.id,
    name: channel.name ?? 'Unnamed Channel',
    type: channel.isTextChannel ? 'text' : 'voice',
    position: channel.position,
    // Mumble's `Channel.parent` defaults to 0 (root) for top-level
    // channels. Subchannels carry their parent's id. The sidebar uses
    // this to build the tree (see channel-sidebar.tsx).
    parent: channel.parent ?? 0
  }
}

// Mumble's root channel is always id=0 and exists for protocol reasons (ACL
// anchor, parent of top-level channels). The UI doesn't expose it as a
// navigable channel — admin views (server-settings) read straight from
// `service.channels` so they still see it for ACL editing.
const ROOT_CHANNEL_ID = 0
const isUserVisible = (c: MumbleChannel): boolean => c.id !== ROOT_CHANNEL_ID

// Use the Web Crypto API (available in modern browsers and Node 19+ globalThis)
// so this module is portable between the Electron renderer and a plain browser build.
const randomUUID = (): string => globalThis.crypto.randomUUID()

export class ChannelsService {
  private _channelListeners: Map<string, Set<number>> = new Map()
  // Track the IMumbleService INSTANCE the lifecycle listeners were bound to,
  // not just the URL. On reconnect a fresh IMumbleService (wrapping a fresh
  // mumble Client + EventEmitter) replaces the old one in the connection
  // manager — the old listeners are gc'd with the old client. A URL-keyed
  // Set would early-return and leave the new client without any listener,
  // so live channelCreate broadcasts arrive on the wire and silently die at
  // the (empty) EventEmitter. Keying on the instance makes "did we already
  // subscribe to *this* server object?" the actual check.
  private _lifecycleSubscribed = new Map<string, IMumbleService>()

  /**
   * Subscribe to channelCreate/Remove events on a server so the UI store
   * stays in sync with live channel mutations (e.g. the create-channel
   * dialog). Idempotent — safe to call from getChannelsForServer on every
   * connection cycle; re-binds on reconnect (see _lifecycleSubscribed
   * comment for why a URL-keyed flag was not enough).
   */
  private subscribeToChannelLifecycle(url: string): void {
    const server = serversService.getServer(url)
    if (!server) return
    if (this._lifecycleSubscribed.get(url) === server) return
    server.on('channelCreate', (channel) => {
      if (!isUserVisible(channel)) return
      useChannelStore.getState().addChannel(url, toUiChannel(channel))
    })
    server.on('channelRemove', (channel) => {
      useChannelStore.getState().removeChannel(url, channel.id)
    })
    // channelUpdate fires for rename / re-parent / position changes (see
    // ChannelManager.syncChannelState in @hachiman/hachiman-node). Without
    // this the sidebar's sort-by-position would never re-render after a
    // drag-and-drop reorder, and a rename would only show up after a full
    // channel-list refetch.
    server.on('channelUpdate', (channel) => {
      if (!isUserVisible(channel)) return
      useChannelStore.getState().updateChannel(url, channel.id, toUiChannel(channel))
    })
    this._lifecycleSubscribed.set(url, server)
  }

  async getChannelsForServer(url: string): Promise<Channel[]> {
    const channelStore = useChannelStore.getState()
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }

    const channels: Channel[] = server.channels.filter(isUserVisible).map(toUiChannel)
    channelStore.setChannels(url, channels)
    this.subscribeToChannelLifecycle(url)
    return channels
  }

  /**
   * Create a new channel on the given server. Defaults the parent to the
   * server's root channel; pass `parentId` to nest under another channel
   * (the right-click "Create Subchannel" path). Server is authoritative —
   * we wait for the `channelCreate` event broadcast to update the store,
   * so the new channel appears with the same id the server assigned.
   */
  async createChannel(
    url: string,
    name: string,
    type: ChannelType,
    parentId?: number
  ): Promise<void> {
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }
    const parent =
      parentId !== undefined
        ? server.mumbleClient.channels.byId(parentId)
        : server.mumbleClient.channels.root
    if (!parent) {
      throw new Error(
        parentId !== undefined
          ? `Parent channel ${parentId} not known on this server`
          : 'Root channel not yet known for this server'
      )
    }
    const channelType =
      type === 'text' ? ChannelState_ChannelType.TEXT : ChannelState_ChannelType.VOICE
    await parent.createSubChannel(name, channelType)
  }

  /**
   * Delete `channelId` on the given server. Sends a ChannelRemove; the
   * server cascade-deletes any subchannels and (for text channels) the
   * persisted chat history. We DON'T pre-prune the local store — the
   * `channelRemove` event we already subscribe to (see
   * subscribeToChannelLifecycle) lands the canonical removal once the
   * server confirms, so a permission-denied response just leaves the UI
   * untouched.
   */
  async deleteChannel(url: string, channelId: number): Promise<void> {
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }
    const ch = server.mumbleClient.channels.byId(channelId)
    if (!ch) throw new Error(`Channel ${channelId} not found on ${url}`)
    await ch.remove()
  }

  /**
   * Move `channelId` to a new sort position within its parent. Sends a
   * partial ChannelState (just `position`) via the channel-edit path; the
   * server broadcasts the canonical post-update state which our
   * `channelUpdate` listener folds into the store.
   *
   * No optimistic update — the server is the ordering authority, and
   * compute-on-broadcast keeps drag-end visually smooth without leaving
   * the UI in a state the server would reject (e.g. PermissionDenied).
   */
  async updateChannelPosition(url: string, channelId: number, position: number): Promise<void> {
    const server = serversService.getServer(url)
    if (!server || !server.isConnected()) {
      throw new Error(`Server with url ${url} is not connected`)
    }
    const ch = server.mumbleClient.channels.byId(channelId)
    if (!ch) throw new Error(`Channel ${channelId} not found on ${url}`)
    await ch.edit({ position })
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
    // Optimistic insert. Two contracts the rest of the pipeline relies on:
    //   1. `author` is the user's actual shown name (NOT the session
    //      number) — server.currentUser.name is what other clients see
    //      via UserState, so the local row matches what a third party
    //      would render. Fallback is the session for the rare cold-start
    //      case where currentUser isn't ready yet.
    //   2. `actorSession` is set to OUR session, which is the key the
    //      live-echo handler below and `prependHistory` use to dedup
    //      this UUID-keyed row against the canonical persisted copy.
    const me = server.currentUser
    const author = me?.name ?? server.clientSession?.toString() ?? 'Unknown'
    const optimistic: Message = {
      id: randomUUID().toString(),
      author,
      content: message,
      date: new Date(),
      avatar: '',
      actorSession: me?.session ?? server.clientSession ?? undefined
    }
    messageStore.addMessage(channelId, optimistic)
    try {
      await server.sendTextMessage(message, [channelId])
    } catch (err) {
      // Roll back so the UI doesn't claim a delivery that never happened.
      messageStore.deleteMessage(channelId, optimistic.id)
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
      if (!msg.channelIds?.includes(channelId)) return
      // `fromUserId` is actually the sender's Mumble session id (see
      // pkgs/hachiman-node/src/client.ts — `fromUserId: textMessage.actor`).
      // Resolve it to the actual user's name so the chat row shows
      // "david" instead of the literal "1". We also carry the session
      // through to messagesStore so a later history reload can dedup the
      // canonical persisted copy against this live UUID row.
      const session = msg.fromUserId
      const sender = session !== undefined ? server.getUserBySession(session) : undefined
      const author = sender?.name ?? session?.toString() ?? 'Unknown'

      // Drop the server's echo of our own send: the optimistic row from
      // sendMessageToChannel is already in the store with the same
      // (actorSession, content) tuple. Without this, the user sees two
      // rows for every message they send — first the optimistic one,
      // then the echo. Match by actorSession + content within a 5s
      // window; same dedup contract `prependHistory` uses against
      // canonical persisted rows, just applied earlier in the pipeline.
      const DEDUP_WINDOW_MS = 5_000
      const now = Date.now()
      const existing = useMessageStore.getState().history.get(channelId) ?? []
      const alreadyOptimistic = existing.some(
        (m) =>
          !/^\d+$/.test(m.id) &&
          m.actorSession === session &&
          m.content === msg.message &&
          now - m.date.getTime() < DEDUP_WINDOW_MS
      )
      if (alreadyOptimistic) return

      messageStore.addMessage(channelId, {
        id: randomUUID().toString(),
        author,
        content: msg.message,
        date: new Date(),
        avatar: '',
        actorSession: session
      })
    })
    listenedChannels.add(channelId)
  }
}

export const channelsService = new ChannelsService()
