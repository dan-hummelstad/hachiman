/**
 * The services of the guild data that is not messages: pins (N13), guild events (N14), threads
 * (N12), blocks (N23) and custom status (N16). services/hachiman.ts mirrors their cache into the
 * stores; these are the calls the UI makes.
 */
import type {
  Channel,
  CreateGuildEventRequest,
  GuildEventWithMe,
  UpdateGuildEventRequest
} from '@hachiman/client'
import { cryptoService } from '@/services/CryptoService'
import { hachiman, syncBlocks, syncEvents } from '@/services/hachiman'
import { createPinsService } from '@/services/PinsService'
import { useChannelStore } from '@/stores/channelStore'
import { useEventsStore } from '@/stores/eventsStore'
import { useThreadsStore } from '@/stores/threadsStore'

export const pinsService = createPinsService({
  get rest() {
    return hachiman.rest
  },
  decrypt: (messages) => cryptoService.client().decryptMessages(messages)
})

/** guildId → the load in flight. */
const eventLoads = new Map<string, Promise<void>>()

export const eventsService = {
  /** Loads the events of a guild into the cache and the store. Never rejects (logs). */
  load(guildId: string): Promise<void> {
    const running = eventLoads.get(guildId)
    if (running) return running
    const p = hachiman
      .fetchGuildEvents(guildId)
      .then(() => syncEvents())
      .catch((e: unknown) => console.warn('[events] load failed', e))
      .finally(() => eventLoads.delete(guildId))
    eventLoads.set(guildId, p)
    return p
  },
  ensureLoaded(guildId: string): void {
    if (!useEventsStore.getState().byGuild.has(guildId)) void eventsService.load(guildId)
  },
  /** GUILD_EVENT_RSVP updates the count and `me`. */
  rsvp: (eventId: string, going: boolean): Promise<void> =>
    hachiman.rest.setEventRsvp(eventId, going),
  /** Needs MANAGE_EVENTS. GUILD_EVENT_CREATE adds it to the store. */
  create: (guildId: string, body: CreateGuildEventRequest): Promise<GuildEventWithMe> =>
    hachiman.rest.createGuildEvent(guildId, body),
  update: (eventId: string, body: UpdateGuildEventRequest): Promise<GuildEventWithMe> =>
    hachiman.rest.updateGuildEvent(eventId, body),
  delete: (eventId: string): Promise<void> => hachiman.rest.deleteGuildEvent(eventId),
  reset(): void {
    eventLoads.clear()
  }
}

export const threadService = {
  /**
   * A thread under a text channel (N12). `startMessageId` is the id (not the client_msg_id) of a
   * message in the parent. CHANNEL_CREATE adds it to channelStore. Messages in the thread use the
   * group of the parent: MessagesService.send(thread.id, ...) works as for any channel.
   */
  create: (parentId: string, name: string, startMessageId?: string): Promise<Channel> =>
    hachiman.rest.createThread(parentId, { name, startMessageId: startMessageId ?? null }),

  /**
   * The 50 most active threads of a channel. Sets the activity order of useThreads, and adds the
   * threads that READY did not carry to the channel cache.
   */
  async list(parentId: string): Promise<Channel[]> {
    const threads = await hachiman.rest.listThreads(parentId)
    const { channels } = hachiman.cache
    let added = false
    for (const t of threads) {
      if (channels.has(t.id)) continue
      channels.set(t.id, t)
      added = true
    }
    if (added) useChannelStore.setState({ channels: new Map(channels) })
    useThreadsStore.getState().setOrder(
      parentId,
      threads.map((t) => t.id)
    )
    return threads
  }
}

export const blockService = {
  /** USER_BLOCK_UPDATE updates the store. */
  block: (userId: string): Promise<void> => hachiman.rest.blockUser(userId),
  unblock: (userId: string): Promise<void> => hachiman.rest.unblockUser(userId),
  /** Loads the block list (after READY). Never rejects (logs). */
  async load(): Promise<void> {
    try {
      await hachiman.fetchBlocks()
      syncBlocks()
    } catch (e) {
      console.warn('[blocks] load failed', e)
    }
  }
}

/**
 * My custom status (N16): `text` '' clears it. `expiresAt` is RFC 3339 or null. The store changes
 * on the PRESENCE_UPDATE echo.
 */
export function setCustomStatus(text: string, expiresAt: string | null = null): void {
  hachiman.setCustomStatus(text.trim(), expiresAt)
}
