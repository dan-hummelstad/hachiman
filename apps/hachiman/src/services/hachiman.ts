import {
  HachimanClient,
  type GatewayDevice,
  type GatewayDispatch,
  type GatewayEvents,
  type GuildEventWithMe,
  type Message,
  type PresenceStatus
} from '@hachiman/client'
import { createTransformWorker } from '@hachiman/crypto'
import { clearDecryptedBlobs } from '@/hooks/use-decrypted-blob'
import { CLIENT_CAPABILITIES, CLIENT_VERSION } from '@/lib/client-version'
import { cryptoService } from '@/services/CryptoService'
import { createDsTransport } from '@/services/ds-transport'
import { docsService } from '@/services/docs/DocsService'
import { blockService, eventsService, pinsService } from '@/services/guild-features'
import { redeemWaitingInvites, resetInvites } from '@/services/InviteService'
import { messagesService } from '@/services/MessagesService'
import { takusenService } from '@/services/TakusenService'
import { messageSound, playSound, startSounds } from '@/services/SoundService'
import { unreadService } from '@/services/UnreadService'
import { createVoiceE2ee } from '@/services/voice-e2ee'
import { voiceService } from '@/services/VoiceService'
import type { IPlatformService } from '@/shared/IPlatformService'
import { resetChannelStore, useChannelStore } from '@/stores/channelStore'
import { resetComposerStore } from '@/stores/composerStore'
import { byStart, resetEventsStore, useEventsStore } from '@/stores/eventsStore'
import { resetThreadsStore } from '@/stores/threadsStore'
import { currentDeviceId, setCryptoFatal, useCryptoStore } from '@/stores/cryptoStore'
import { resetGuildStore, useGuildStore } from '@/stores/guildStore'
import { resetMessagesStore, useMessageStore } from '@/stores/messagesStore'
import { closeAllDialogs } from '@/stores/dialogStore'
import { useDocsStore } from '@/stores/docsStore'
import {
  clearHistory,
  DM_HOME,
  forgetGuild,
  openChannel,
  selectedChannelId,
  useNavStore
} from '@/stores/navStore'
import { notifyPrefs, usePrefsStore } from '@/stores/prefsStore'
import { loadTabs, pruneTabs, type TabTarget } from '@/stores/tabsStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { resetUserStore, useUserStore } from '@/stores/userStore'
import { resetVoiceMirror, useVoiceStore } from '@/stores/voiceStore'

/** IDENTIFY facts (§12.13). Null until the crypto Worker has a device row: connect() waits. */
function device(): GatewayDevice | null {
  const deviceId = currentDeviceId()
  return deviceId
    ? { deviceId, capabilities: [...CLIENT_CAPABILITIES], clientVersion: CLIENT_VERSION }
    : null
}

/** One delegate and one transform Worker per call, for the channel that VoiceService joins. */
function voiceE2ee(): ReturnType<typeof createVoiceE2ee> {
  const { guildId, channelId } = useVoiceStore.getState()
  if (!guildId || !channelId) throw new Error('voice e2ee: no voice target')
  return createVoiceE2ee({
    crypto: cryptoService.client(),
    target: { guildId, channelId },
    createWorker: createTransformWorker,
    createTransform: (worker, options, transfer) =>
      new RTCRtpScriptTransform(worker, options, transfer),
    createChannel: () => new MessageChannel(),
    onHandle: (handle) =>
      useCryptoStore.setState({ voice: handle ? { handle, epoch: null, roster: [] } : null })
  })
}

/** The one HachimanClient. Tokens come from the Takusen session. */
export const hachiman = new HachimanClient({
  apiUrl: `${takusenService.env.apiBase.replace(/\/$/, '')}/v1`,
  gatewayUrl: takusenService.env.gatewayUrl,
  getToken: takusenService.getAccessToken,
  device,
  proveDevice: (req) => cryptoService.proveDevice(req),
  voiceE2ee
})

const TYPING_MS = 10_000

// ponytail: copies the touched cache slice on every event (O(guild size)); fine until guilds get large.
function copy2<K, K2, V>(m: Map<K, Map<K2, V>>): Map<K, Map<K2, V>> {
  return new Map([...m].map(([k, v]) => [k, new Map(v)]))
}

function syncGuilds(): void {
  const c = hachiman.cache
  useGuildStore.setState({
    guilds: new Map(c.guilds),
    roles: copy2(c.roles),
    members: copy2(c.members)
  })
}

function syncPresences(): void {
  useGuildStore.setState({
    presences: new Map(hachiman.cache.presences),
    customStatuses: new Map(hachiman.cache.customStatuses)
  })
}

/** cache.events → eventsStore, each guild earliest start first. */
export function syncEvents(): void {
  const byGuild = new Map<string, GuildEventWithMe[]>()
  for (const [guildId, events] of hachiman.cache.events)
    byGuild.set(guildId, [...events.values()].sort(byStart))
  useEventsStore.setState({ byGuild })
}

/** cache.blocks → userStore, and the `blocked` flag of the message rows. */
export function syncBlocks(): void {
  const blocks = new Set(hachiman.cache.blocks)
  useUserStore.setState({ blocks })
  useMessageStore.getState().setBlockedUsers(blocks)
}

function syncChannels(): void {
  useChannelStore.setState({ channels: new Map(hachiman.cache.channels) })
}

function syncVoiceStates(): void {
  useVoiceStore.setState({ voiceStates: copy2(hachiman.cache.voiceStates) })
}

/** A tab's target is still there: its channel is in the cache, and its page (once loaded). */
function tabExists(t: TabTarget): boolean {
  if (!hachiman.cache.channels.has(t.id)) return false
  if (t.kind !== 'page') return true
  const pages = useDocsStore.getState().pagesByChannel.get(t.id)
  return pages === undefined || pages.some((p) => p.id === t.pageId)
}

/** The account whose tabs and per-account preferences apply (null = signed out). */
function setAccount(userId: string | null): void {
  usePrefsStore.getState().setAccountId(userId)
  loadTabs(userId)
}

/** Channels went away: drop their tabs and read states. */
function onChannelsGone(): void {
  pruneTabs(tabExists)
  unreadService.onChannelsChanged()
}

function syncAll(): void {
  useUserStore.setState({ me: hachiman.cache.user })
  syncGuilds()
  syncPresences()
  syncChannels()
  syncVoiceStates()
  syncEvents()
}

const onUpdate = (e: GatewayDispatch): void => {
  switch (e.t) {
    case 'GUILD_DELETE':
      // Left / kicked / deleted: drop the selection and its remembered channel.
      forgetGuild(e.d.id)
      syncAll()
      return onChannelsGone()
    case 'READY': {
      docsService.onReady(true)
      messagesService.onNewSession(selectedChannelId())
      useUserStore.setState({ status: hachiman.cache.presences.get(e.d.user.id) ?? 'online' })
      cryptoService.sync()
      syncAll()
      setAccount(e.d.user.id)
      pruneTabs(tabExists)
      unreadService.onReady()
      void blockService.load()
      loadSelectedGuildEvents()
      return redeemWaitingInvites()
    }
    case 'RESUMED':
      docsService.onReady(false)
      cryptoService.sync()
      return syncAll()
    case 'GUILD_CREATE':
      syncAll()
      loadSelectedGuildEvents()
      // A joined invite with history waits for the members of its guild (§12.11.4).
      return redeemWaitingInvites()
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'CHANNEL_DELETE':
      if (e.t === 'CHANNEL_DELETE') docsService.onChannelDelete(e.d.id)
      syncChannels()
      if (e.t === 'CHANNEL_DELETE') onChannelsGone()
      return
    case 'VOICE_STATE_UPDATE':
      return syncVoiceStates()
    case 'USER_UPDATE':
      return useUserStore.setState({ me: hachiman.cache.user })
    case 'GUILD_UPDATE':
    case 'GUILD_MEMBER_ADD':
    case 'GUILD_MEMBER_UPDATE':
    case 'GUILD_MEMBER_REMOVE':
    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE':
    case 'GUILD_ROLE_DELETE':
      return syncGuilds()
    case 'PRESENCE_UPDATE':
      // The raw event keeps 'offline' (Invisible) for me; the cache drops it.
      if (e.d.userId === hachiman.cache.user?.id) useUserStore.setState({ status: e.d.status })
      return syncPresences()
    case 'GUILD_EVENT_CREATE':
    case 'GUILD_EVENT_UPDATE':
    case 'GUILD_EVENT_DELETE':
    case 'GUILD_EVENT_RSVP':
      return syncEvents()
    case 'USER_BLOCK_UPDATE':
      return syncBlocks()
    case 'CHANNEL_PINS_UPDATE':
      return pinsService.onPinsUpdate(e.d.channelId)
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

/** Set my presence: shown immediately, then confirmed by the PRESENCE_UPDATE echo. */
export function setMyStatus(status: PresenceStatus): void {
  useUserStore.setState({ status })
  hachiman.gateway.updatePresence(status)
}

/** Open (or reuse) a 1:1 DM with `userId` and switch the view to it. */
export async function openDmWith(userId: string): Promise<void> {
  const dm = await hachiman.rest.openDm([userId])
  openChannel(DM_HOME, dm.id)
}

/** MESSAGE_UPDATE: decrypt, then store. */
const onMessageUpdate = (m: Message): void => {
  void messagesService.ingest([m])
}

/** MESSAGE_CREATE: decrypt, store, then the typing line and the sound (mentions are in the content). */
const onMessageCreate = async (m: Message): Promise<void> => {
  const [row] = await messagesService.ingest([m])
  useMessageStore.getState().setTyping(m.channelId, m.author.id, null)
  unreadService.onMessageCreate(m, row)
  const me = hachiman.cache.user
  if (!me || row?.decrypt.status !== 'ok' || row.kind === 'page_activity' || row.blocked) return
  const viewing = selectedChannelId() === m.channelId && document.hasFocus()
  const myRoles = m.guildId ? (hachiman.cache.members.get(m.guildId)?.get(me.id)?.roles ?? []) : []
  const sound = messageSound(row, me, viewing, myRoles, notifyPrefs())
  if (sound) playSound(sound)
}

const onTyping = (d: GatewayEvents['TYPING_START']): void => {
  if (d.userId === hachiman.cache.user?.id) return
  const until = Date.now() + TYPING_MS
  const store = useMessageStore.getState()
  store.setTyping(d.channelId, d.userId, until)
  setTimeout(() => {
    if (useMessageStore.getState().typing.get(d.channelId)?.get(d.userId) === until) {
      useMessageStore.getState().setTyping(d.channelId, d.userId, null)
    }
  }, TYPING_MS)
}

/** The §12.13 events go to the crypto Worker. Written out so TypeScript checks each payload. */
function forwardCryptoEvents(): void {
  const fwd = cryptoService.onGatewayEvent.bind(cryptoService)
  hachiman.on('MLS_HANDSHAKE', (d) => fwd({ t: 'MLS_HANDSHAKE', d }))
  hachiman.on('MLS_BATCH_ASSIGN', (d) => fwd({ t: 'MLS_BATCH_ASSIGN', d }))
  hachiman.on('MLS_JOIN_UPDATE', (d) => fwd({ t: 'MLS_JOIN_UPDATE', d }))
  hachiman.on('MLS_GROUP_UPDATE', (d) => fwd({ t: 'MLS_GROUP_UPDATE', d }))
  hachiman.on('DEVICE_INBOX', (d) => fwd({ t: 'DEVICE_INBOX', d }))
  hachiman.on('DEVICE_LINK', (d) => fwd({ t: 'DEVICE_LINK', d }))
  hachiman.on('USER_KEYS_UPDATE', (d) => fwd({ t: 'USER_KEYS_UPDATE', d }))
  hachiman.on('KEY_PACKAGES_LOW', (d) => fwd({ t: 'KEY_PACKAGES_LOW', d }))
  hachiman.on('KT_TREE_HEAD', (d) => fwd({ t: 'KT_TREE_HEAD', d }))
  // A revoked invite with history: the Worker sends no more bundles for it (§12.11.4).
  hachiman.on('INVITE_DELETE', (d) => fwd({ t: 'INVITE_DELETE', d }))
}

/** Gateway close 4012 or 4013 (§12.13): the client does not reconnect. 4013 also signs out. */
const onFatal = ({ code }: { code: number }): void => {
  if (code === 4012) setCryptoFatal('update_required')
  if (code === 4013) {
    setCryptoFatal('device_revoked')
    takusenService.signOut()
  }
}

let started = false
let platform: IPlatformService | null = null

/** The crypto Worker of the signed-in user. The gateway connects when it has a device id. */
function startCrypto(): void {
  const session = useTakusenStore.getState().session
  if (!session) return
  void cryptoService.start({
    userId: session.user.id,
    platform,
    transport: createDsTransport(hachiman.rest, hachiman.cache)
  })
}

/**
 * Idempotent: wires client events → stores and connects/disconnects with the Takusen session.
 * `host` gives the crypto Worker its wrap key (§11). Without it the Worker does not start.
 */
export function startHachiman(host?: IPlatformService): void {
  const late = host !== undefined && platform === null && started
  if (host) platform = host
  if (late && useTakusenStore.getState().session && useCryptoStore.getState().phase !== 'ready')
    startCrypto()
  if (started) return
  started = true

  hachiman.on('update', onUpdate)
  hachiman.on('state', (state) => {
    useUserStore.setState({ gatewayState: state })
    if (state !== 'ready') docsService.onOffline()
  })
  hachiman.on('MESSAGE_CREATE', (m) => void onMessageCreate(m))
  hachiman.on('MESSAGE_UPDATE', onMessageUpdate)
  hachiman.on('MESSAGE_DELETE', (d) => {
    messagesService.forget(d.id)
    useMessageStore.getState().remove(d.channelId, d.id)
  })
  hachiman.on('TYPING_START', onTyping)
  hachiman.on('READ_STATE_UPDATE', (d) => unreadService.onReadStateUpdate(d))
  hachiman.on('fatal', onFatal)
  // 4004: the gateway rejected the token before its expiry. A refresh that fails signs out.
  hachiman.gateway.on('close', ({ code }) => {
    if (code === 4004) takusenService.refreshNow()
  })
  hachiman.on('PAGE_CREATE', (d) => docsService.onPageEvent(d))
  hachiman.on('PAGE_UPDATE', (d) => docsService.onPageEvent(d))
  hachiman.on('PAGE_DELETE', (d) => docsService.onPageDelete(d))
  hachiman.on('DOC_UPDATE', (d) => docsService.onDocUpdate(d))
  hachiman.on('DOC_AWARENESS', (d) => docsService.onDocAwareness(d))
  forwardCryptoEvents()
  cryptoService.on('epochKeysAvailable', ({ groupId }) => {
    void messagesService.retryGroup(groupId)
    pinsService.retryGroup(groupId)
    docsService.retry()
  })
  // This device joined a group: the page titles of that group decrypt now.
  cryptoService.on('membership', (e) => docsService.onMembership(e))
  // A new user in a text group: re-wrap the pages of its pages channels (§12.20).
  cryptoService.on('usersAdded', (e) => docsService.onUsersAdded(e))
  // A deleted page closes its tabs.
  useDocsStore.subscribe((s, p) => {
    if (s.pagesByChannel !== p.pagesByChannel) pruneTabs(tabExists)
  })
  cryptoService.on('status', (s) => {
    if (s.state !== 'ready') return
    unreadService.onCryptoReady()
    // Setup or linking finished: catch up and decrypt what waited.
    if (hachiman.gateway.state === 'ready') cryptoService.sync()
    messagesService.retryAll()
    pinsService.retryAll()
    redeemWaitingInvites()
  })
  // A guild switch loads the events of that guild (N14).
  useNavStore.subscribe((s, prev) => {
    if (s.guildKey !== prev.guildKey) loadSelectedGuildEvents()
  })
  voiceService.start()
  unreadService.start()
  startSounds()
  // Back online: reconnect now instead of after the remaining backoff (up to 30 s).
  window.addEventListener('online', () => hachiman.gateway.retryNow())

  const apply = (signedIn: boolean): void => {
    if (signedIn) {
      setAccount(useTakusenStore.getState().session?.user.id ?? null)
      startCrypto()
      hachiman.connect()
      return
    }
    // Leave first: a voice session that the disconnect drops would play the "connection lost" sound.
    voiceService.leaveVoice()
    hachiman.disconnect()
    cryptoService.stop()
    messagesService.reset()
    pinsService.reset()
    eventsService.reset()
    docsService.reset()
    resetInvites()
    clearDecryptedBlobs()
    resetUserStore()
    resetGuildStore()
    resetChannelStore()
    resetVoiceMirror()
    resetMessagesStore()
    unreadService.reset()
    setAccount(null)
    clearHistory()
    resetEventsStore()
    resetThreadsStore()
    resetComposerStore()
    closeAllDialogs() // open dialogs belong to the session that just ended
  }
  let signedIn = useTakusenStore.getState().session !== null
  if (signedIn) apply(true)
  useTakusenStore.subscribe((s) => {
    const next = s.session !== null
    if (next !== signedIn) apply((signedIn = next))
  })
}
