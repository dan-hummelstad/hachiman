/**
 * The services of the guild data that is not messages: pins (N13), guild events (N14), threads
 * (N12), blocks (N23) and custom status (N16). Each is a client feature (services/features.ts)
 * that mirrors its cache into its store; the services are the calls the UI makes.
 */
import type {
  Channel,
  CreateGuildEventRequest,
  GatewayDispatch,
  GuildEventWithMe,
  UpdateGuildEventRequest,
  User
} from '@hachiman/client'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/client'
import type { ClientFeature } from '@/services/features'
import { createPinsService } from '@/services/PinsService'
import { useChannelStore } from '@/stores/channelStore'
import { byStart, resetEventsStore, useEventsStore } from '@/stores/eventsStore'
import { DM_HOME, useNavStore } from '@/stores/navStore'
import { useThreadsStore } from '@/stores/threadsStore'
import { useUserStore } from '@/stores/userStore'

export const pinsService = createPinsService({
  get rest() {
    return hachiman.rest
  },
  decrypt: (messages) => cryptoService.client().decryptMessages(messages)
})

export const pinsFeature: ClientFeature = {
  name: 'pins',
  onDispatch(e: GatewayDispatch): void {
    if (e.t === 'CHANNEL_PINS_UPDATE') pinsService.onPinsUpdate(e.d.channelId)
  },
  onCryptoReady: () => pinsService.retryAll(),
  onGroupKeys: (groupId) => pinsService.retryGroup(groupId),
  reset: () => pinsService.reset()
}

/** cache.events → eventsStore, each guild earliest start first. */
export function syncEvents(): void {
  const byGuild = new Map<string, GuildEventWithMe[]>()
  for (const [guildId, events] of hachiman.cache.events)
    byGuild.set(guildId, [...events.values()].sort(byStart))
  useEventsStore.setState({ byGuild })
}

/** guildId → the load in flight. */
const eventLoads = new Map<string, Promise<void>>()
/** Bumped by sign-out, so a load of an older session does not write. */
let eventsSession = 0

export const eventsService = {
  /** Loads the events of a guild into the cache and the store. Never rejects (logs). */
  load(guildId: string): Promise<void> {
    const running = eventLoads.get(guildId)
    if (running) return running
    const started = eventsSession
    const p = hachiman
      .fetchGuildEvents(guildId)
      .then(() => {
        if (started === eventsSession) syncEvents()
      })
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
    eventsSession++
    eventLoads.clear()
  }
}

/**
 * The events of the selected guild load on READY, on GUILD_CREATE and on every guild switch
 * (N14): whichever comes once the guild is in the cache.
 */
function loadSelectedGuildEvents(): void {
  const { guildKey } = useNavStore.getState()
  if (guildKey !== DM_HOME && hachiman.cache.guilds.has(guildKey))
    eventsService.ensureLoaded(guildKey)
}

let eventsStarted = false

export const eventsFeature: ClientFeature = {
  name: 'events',
  onReady(): void {
    syncEvents()
    loadSelectedGuildEvents()
    if (eventsStarted) return
    eventsStarted = true
    // A guild switch loads the events of that guild (N14).
    useNavStore.subscribe((s, prev) => {
      if (s.guildKey !== prev.guildKey) loadSelectedGuildEvents()
    })
  },
  onDispatch(e: GatewayDispatch): void {
    switch (e.t) {
      case 'GUILD_CREATE':
        return loadSelectedGuildEvents()
      case 'GUILD_DELETE':
      case 'GUILD_EVENT_CREATE':
      case 'GUILD_EVENT_UPDATE':
      case 'GUILD_EVENT_DELETE':
      case 'GUILD_EVENT_RSVP':
        return syncEvents()
    }
  },
  reset(): void {
    eventsService.reset()
    resetEventsStore()
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

/** cache.blocks → userStore. A user of the block list stays in `blockedUsers` while blocked. */
function syncBlocks(users?: readonly User[]): void {
  const blocks = new Set(hachiman.cache.blocks)
  useUserStore.setState((s) => {
    const blockedUsers = new Map<string, User>()
    for (const u of users ?? s.blockedUsers.values())
      if (blocks.has(u.id)) blockedUsers.set(u.id, u)
    return { blocks, blockedUsers }
  })
}

export const blockService = {
  /** USER_BLOCK_UPDATE updates the store. */
  block: (userId: string): Promise<void> => hachiman.rest.blockUser(userId),
  unblock: (userId: string): Promise<void> => hachiman.rest.unblockUser(userId),
  /** Loads the block list with the users (after READY, or for a name). Never rejects (logs). */
  async load(): Promise<void> {
    try {
      const list = await hachiman.fetchBlocks()
      syncBlocks(list.map((b) => b.user))
    } catch (e) {
      console.warn('[blocks] load failed', e)
    }
  }
}

export const blocksFeature: ClientFeature = {
  name: 'blocks',
  onReady: () => void blockService.load(),
  onDispatch(e: GatewayDispatch): void {
    if (e.t === 'USER_BLOCK_UPDATE') syncBlocks()
  }
}

/**
 * My custom status (N16): `text` '' clears it. `expiresAt` is RFC 3339 or null. The store changes
 * on the PRESENCE_UPDATE echo.
 */
export function setCustomStatus(text: string, expiresAt: string | null = null): void {
  hachiman.setCustomStatus(text.trim(), expiresAt)
}
