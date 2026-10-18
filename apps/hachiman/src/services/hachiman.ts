import type { GatewayDispatch, GatewayEvents, Message, PresenceStatus } from '@hachiman/client'
import { clearDecryptedBlobs } from '@/hooks/use-decrypted-blob'
import { emojisById } from '@/lib/custom-emoji'
import { hachiman } from '@/services/client'
import { cryptoService } from '@/services/CryptoService'
import { createDsTransport } from '@/services/ds-transport'
import { docsService } from '@/services/docs/DocsService'
import { features, type ClientFeature } from '@/services/features'
import { blocksFeature, eventsFeature, pinsFeature } from '@/services/guild-features'
import { redeemWaitingInvites, resetInvites } from '@/services/InviteService'
import { messageContext } from '@/services/message-context'
import { messagesService } from '@/services/MessagesService'
import { takusenService } from '@/services/TakusenService'
import { pokeFeature } from '@/services/poke'
import { pushFeature } from '@/services/PushService'
import { soundboardFeature } from '@/services/soundboard'
import { soundFeature, startSounds } from '@/services/SoundService'
import { tabsFeature } from '@/services/tabs-feature'
import { unreadFeature } from '@/services/UnreadService'
import { voiceService } from '@/services/VoiceService'
import { callRingService } from '@/services/CallRingService'
import type { IPlatformService } from '@/shared/IPlatformService'
import { resetChannelStore, useChannelStore } from '@/stores/channelStore'
import { resetComposerStore } from '@/stores/composerStore'
import { resetThreadsStore } from '@/stores/threadsStore'
import { setCryptoFatal, useCryptoStore } from '@/stores/cryptoStore'
import { resetGuildStore, useGuildStore } from '@/stores/guildStore'
import { resetMessagesStore, useMessageStore } from '@/stores/messagesStore'
import { closeAllDialogs } from '@/stores/dialogStore'
import {
  clearHistory,
  startNavHistory,
  DM_HOME,
  forgetGuild,
  openChannel,
  selectedChannelId,
  useNavStore
} from '@/stores/navStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { migrateLegacyTabs } from '@/stores/tabsStore'
import { useTakusenStore } from '@/stores/takusenStore'
import { resetUserStore, useUserStore } from '@/stores/userStore'
import { resetVoiceMirror, useVoiceStore } from '@/stores/voiceStore'

export { hachiman }

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
    members: copy2(c.members),
    emojis: new Map(c.emojis),
    emojiIndex: emojisById(c.emojis)
  })
}

function syncPresences(): void {
  useGuildStore.setState({
    presences: new Map(hachiman.cache.presences),
    customStatuses: new Map(hachiman.cache.customStatuses)
  })
}

function syncChannels(): void {
  useChannelStore.setState({ channels: new Map(hachiman.cache.channels) })
}

function syncVoiceStates(): void {
  useVoiceStore.setState({ voiceStates: copy2(hachiman.cache.voiceStates) })
}

/** The account whose per-account preferences (tabs too) apply (null = signed out). */
function setAccount(userId: string | null): void {
  usePrefsStore.getState().setAccountId(userId)
  if (userId !== null) migrateLegacyTabs(userId)
}

/** The messages, the pages and the invites with history hook into the session as features too. */
const messagesFeature: ClientFeature = {
  name: 'messages',
  onCryptoReady: () => messagesService.retryAll(),
  onGroupKeys: (groupId) => void messagesService.retryGroup(groupId),
  reset: () => messagesService.reset()
}

const docsFeature: ClientFeature = {
  name: 'docs',
  onReady: () => docsService.onReady(true),
  onDispatch(e: GatewayDispatch): void {
    switch (e.t) {
      case 'RESUMED':
        return docsService.onReady(false)
      case 'CHANNEL_DELETE':
        return docsService.onChannelDelete(e.d.id)
      case 'PAGE_CREATE':
      case 'PAGE_UPDATE':
        return docsService.onPageEvent(e.d)
      case 'PAGE_DELETE':
        return docsService.onPageDelete(e.d)
    }
  },
  onGroupKeys: () => docsService.retry(),
  reset: () => docsService.reset()
}

const invitesFeature: ClientFeature = {
  name: 'invites',
  onReady: () => redeemWaitingInvites(),
  onDispatch(e: GatewayDispatch): void {
    // A joined invite with history waits for the members of its guild (§12.11.4).
    if (e.t === 'GUILD_CREATE') redeemWaitingInvites()
  },
  onCryptoReady: () => redeemWaitingInvites(),
  reset: () => resetInvites()
}

features.register(
  messagesFeature,
  docsFeature,
  invitesFeature,
  unreadFeature,
  soundFeature,
  pushFeature,
  pinsFeature,
  eventsFeature,
  blocksFeature,
  tabsFeature,
  pokeFeature,
  soundboardFeature
)

function syncAll(): void {
  useUserStore.setState({ me: hachiman.cache.user })
  syncGuilds()
  syncPresences()
  syncChannels()
  syncVoiceStates()
}

/** The core mirrors: the cache → the stores. */
function mirror(e: GatewayDispatch): void {
  switch (e.t) {
    case 'GUILD_DELETE':
      // Left / kicked / deleted: drop the selection and its remembered channel.
      forgetGuild(e.d.id)
      return syncAll()
    case 'READY':
      messagesService.onNewSession(selectedChannelId())
      useUserStore.setState({ status: hachiman.cache.presences.get(e.d.user.id) ?? 'online' })
      cryptoService.sync()
      syncAll()
      dropUnknownGuild()
      return setAccount(e.d.user.id)
    case 'RESUMED':
      cryptoService.sync()
      return syncAll()
    case 'GUILD_CREATE':
      return syncAll()
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'CHANNEL_DELETE':
      return syncChannels()
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
    case 'GUILD_EMOJIS_UPDATE':
      return syncGuilds()
    case 'PRESENCE_UPDATE':
      // The raw event keeps 'offline' (Invisible) for me; the cache drops it.
      if (e.d.userId === hachiman.cache.user?.id) useUserStore.setState({ status: e.d.status })
      return syncPresences()
  }
}

/**
 * The selected guild is saved on the device, not per account. After a sign-in as another account
 * (or a guild left while offline) it can name a guild that READY does not list: fall back to the
 * DM home instead of a guild header that never loads.
 */
function dropUnknownGuild(): void {
  const { guildKey } = useNavStore.getState()
  if (guildKey !== DM_HOME && !hachiman.cache.guilds.has(guildKey)) forgetGuild(guildKey)
}

const onUpdate = (e: GatewayDispatch): void => {
  mirror(e)
  if (e.t === 'READY') features.ready()
  features.dispatch(e)
}

/** Set my presence: shown immediately, then confirmed by the PRESENCE_UPDATE echo. */
export function setMyStatus(status: PresenceStatus): void {
  useUserStore.setState({ status })
  hachiman.gateway.updatePresence(status)
}

/** The id of the 1:1 DM with one user (opened or reused), or of a new group DM with several. */
export async function dmChannelWith(...userIds: string[]): Promise<string> {
  return (await hachiman.rest.openDm(userIds)).id
}

/** `dmChannelWith`, then switch the view to it. */
export async function openDmWith(...userIds: string[]): Promise<void> {
  openChannel(DM_HOME, await dmChannelWith(...userIds))
}

/** MESSAGE_UPDATE: decrypt, then store. */
const onMessageUpdate = (m: Message): void => {
  void messagesService.ingest([m])
}

/** MESSAGE_CREATE: decrypt, store, clear the typing line, then the features (unread, sound). */
const onMessageCreate = async (m: Message): Promise<void> => {
  const [row] = await messagesService.ingest([m])
  useMessageStore.getState().setTyping(m.channelId, m.author.id, null)
  features.message(m, row, messageContext(m.channelId, row))
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

export const hostPlatform = (): IPlatformService | null => platform

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
  hachiman.on('fatal', onFatal)
  // 4004: the gateway rejected the token before its expiry. A refresh that fails signs out.
  hachiman.gateway.on('close', ({ code }) => {
    if (code === 4004) takusenService.refreshNow()
  })
  hachiman.on('DOC_UPDATE', (d) => docsService.onDocUpdate(d))
  hachiman.on('DOC_AWARENESS', (d) => docsService.onDocAwareness(d))
  forwardCryptoEvents()
  cryptoService.on('epochKeysAvailable', ({ groupId }) => features.groupKeys(groupId))
  // This device joined a group: the page titles of that group decrypt now.
  cryptoService.on('membership', (e) => docsService.onMembership(e))
  // A new user in a text group: re-wrap the pages of its pages channels (§12.20).
  cryptoService.on('usersAdded', (e) => docsService.onUsersAdded(e))
  cryptoService.on('status', (s) => {
    if (s.state !== 'ready') return
    // Setup or linking finished: catch up and decrypt what waited.
    if (hachiman.gateway.state === 'ready') cryptoService.sync()
    features.cryptoReady()
  })
  startNavHistory()
  voiceService.start()
  callRingService.start()
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
    features.reset()
    clearDecryptedBlobs()
    resetUserStore()
    resetGuildStore()
    resetChannelStore()
    resetVoiceMirror()
    resetMessagesStore()
    setAccount(null)
    clearHistory()
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
