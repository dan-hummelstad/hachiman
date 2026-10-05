import {
  HachimanClient,
  type GatewayDevice,
  type GatewayDispatch,
  type GatewayEvents,
  type Message,
  type PresenceStatus
} from '@hachiman/client'
import { createTransformWorker } from '@hachiman/crypto'
import { clearDecryptedBlobs } from '@/hooks/use-decrypted-blob'
import { CLIENT_CAPABILITIES, CLIENT_VERSION } from '@/lib/client-version'
import { cryptoService } from '@/services/CryptoService'
import { createDsTransport } from '@/services/ds-transport'
import { docsService } from '@/services/docs/DocsService'
import { messagesService } from '@/services/MessagesService'
import { takusenService } from '@/services/TakusenService'
import { messageSound, playSound, startSounds } from '@/services/SoundService'
import { createVoiceE2ee } from '@/services/voice-e2ee'
import { voiceService } from '@/services/VoiceService'
import type { IPlatformService } from '@/shared/IPlatformService'
import { resetChannelStore, useChannelStore } from '@/stores/channelStore'
import { currentDeviceId, setCryptoFatal, useCryptoStore } from '@/stores/cryptoStore'
import { resetGuildStore, useGuildStore } from '@/stores/guildStore'
import { resetMessagesStore, useMessageStore } from '@/stores/messagesStore'
import { closeAllDialogs } from '@/stores/dialogStore'
import { DM_HOME, forgetGuild, openChannel, selectedChannelId } from '@/stores/navStore'
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
  useGuildStore.setState({ presences: new Map(hachiman.cache.presences) })
}

function syncChannels(): void {
  useChannelStore.setState({ channels: new Map(hachiman.cache.channels) })
}

function syncVoiceStates(): void {
  useVoiceStore.setState({ voiceStates: copy2(hachiman.cache.voiceStates) })
}

function syncAll(): void {
  useUserStore.setState({ me: hachiman.cache.user })
  syncGuilds()
  syncPresences()
  syncChannels()
  syncVoiceStates()
}

const onUpdate = (e: GatewayDispatch): void => {
  switch (e.t) {
    case 'GUILD_DELETE':
      // Left / kicked / deleted: drop the selection and its remembered channel.
      forgetGuild(e.d.id)
      return syncAll()
    case 'READY': {
      docsService.onReady(true)
      messagesService.onNewSession(selectedChannelId())
      useUserStore.setState({ status: hachiman.cache.presences.get(e.d.user.id) ?? 'online' })
      cryptoService.sync()
      return syncAll()
    }
    case 'RESUMED':
      docsService.onReady(false)
      cryptoService.sync()
      return syncAll()
    case 'GUILD_CREATE':
      return syncAll()
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'CHANNEL_DELETE':
      if (e.t === 'CHANNEL_DELETE') docsService.onChannelDelete(e.d.id)
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
      return syncGuilds()
    case 'PRESENCE_UPDATE':
      // The raw event keeps 'offline' (Invisible) for me; the cache drops it.
      if (e.d.userId === hachiman.cache.user?.id) useUserStore.setState({ status: e.d.status })
      return syncPresences()
  }
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
  const me = hachiman.cache.user
  if (!me || row?.decrypt.status !== 'ok') return
  const viewing = selectedChannelId() === m.channelId && document.hasFocus()
  const myRoles = m.guildId ? (hachiman.cache.members.get(m.guildId)?.get(me.id)?.roles ?? []) : []
  const sound = messageSound(row, me, viewing, myRoles)
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
    docsService.retry()
  })
  cryptoService.on('status', (s) => {
    if (s.state !== 'ready') return
    // Setup or linking finished: catch up and decrypt what waited.
    if (hachiman.gateway.state === 'ready') cryptoService.sync()
    messagesService.retryAll()
  })
  voiceService.start()
  startSounds()
  // Back online: reconnect now instead of after the remaining backoff (up to 30 s).
  window.addEventListener('online', () => hachiman.gateway.retryNow())

  const apply = (signedIn: boolean): void => {
    if (signedIn) {
      startCrypto()
      hachiman.connect()
      return
    }
    // Leave first: a voice session that the disconnect drops would play the "connection lost" sound.
    voiceService.leaveVoice()
    hachiman.disconnect()
    cryptoService.stop()
    messagesService.reset()
    docsService.reset()
    clearDecryptedBlobs()
    resetUserStore()
    resetGuildStore()
    resetChannelStore()
    resetVoiceMirror()
    resetMessagesStore()
    closeAllDialogs() // open dialogs belong to the session that just ended
  }
  let signedIn = useTakusenStore.getState().session !== null
  if (signedIn) apply(true)
  useTakusenStore.subscribe((s) => {
    const next = s.session !== null
    if (next !== signedIn) apply((signedIn = next))
  })
}
