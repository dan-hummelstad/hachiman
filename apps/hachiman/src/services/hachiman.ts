import {
  HachimanClient,
  type GatewayDispatch,
  type GatewayEvents,
  type Message,
  type PresenceStatus
} from '@hachiman/client'
import { oracleService } from '@/services/OracleService'
import { messageSound, playSound, startSounds } from '@/services/SoundService'
import { voiceService } from '@/services/VoiceService'
import { resetChannelStore, useChannelStore } from '@/stores/channelStore'
import { resetGuildStore, useGuildStore } from '@/stores/guildStore'
import { resetMessagesStore, useMessageStore } from '@/stores/messagesStore'
import { closeAllDialogs } from '@/stores/dialogStore'
import { DM_HOME, forgetGuild, openChannel, useNavStore } from '@/stores/navStore'
import { useOracleStore } from '@/stores/oracleStore'
import { resetUserStore, useUserStore } from '@/stores/userStore'
import { resetVoiceMirror, useVoiceStore } from '@/stores/voiceStore'

/** The one HachimanClient. Tokens come from the Oracle session. */
export const hachiman = new HachimanClient({
  apiUrl: `${oracleService.env.apiBase.replace(/\/$/, '')}/v1`,
  gatewayUrl: oracleService.env.gatewayUrl,
  getToken: oracleService.getAccessToken
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
    case 'READY':
      useUserStore.setState({ status: hachiman.cache.presences.get(e.d.user.id) ?? 'online' })
      return syncAll()
    case 'RESUMED':
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

const onMessage = (m: Message): void => {
  useMessageStore.getState().upsert(m.channelId, [m])
  useMessageStore.getState().setTyping(m.channelId, m.author.id, null)
}

const onMessageCreate = (m: Message): void => {
  onMessage(m)
  const me = hachiman.cache.user
  if (!me) return
  const nav = useNavStore.getState()
  const viewing = nav.channelByGuild[nav.guildKey] === m.channelId && document.hasFocus()
  const sound = messageSound(m, me, viewing)
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

let started = false

/** Idempotent: wires client events → stores and connects/disconnects with the Oracle session. */
export function startHachiman(): void {
  if (started) return
  started = true

  hachiman.on('update', onUpdate)
  hachiman.on('state', (state) => useUserStore.setState({ gatewayState: state }))
  hachiman.on('MESSAGE_CREATE', onMessageCreate)
  hachiman.on('MESSAGE_UPDATE', onMessage)
  hachiman.on('MESSAGE_DELETE', (d) => useMessageStore.getState().remove(d.channelId, d.id))
  hachiman.on('TYPING_START', onTyping)
  voiceService.start()
  startSounds()

  const apply = (signedIn: boolean): void => {
    if (signedIn) {
      hachiman.connect()
      return
    }
    // Leave first: a voice session that the disconnect drops would play the "connection lost" sound.
    voiceService.leaveVoice()
    hachiman.disconnect()
    resetUserStore()
    resetGuildStore()
    resetChannelStore()
    resetVoiceMirror()
    resetMessagesStore()
    closeAllDialogs() // open dialogs belong to the session that just ended
  }
  let signedIn = useOracleStore.getState().session !== null
  if (signedIn) apply(true)
  useOracleStore.subscribe((s) => {
    const next = s.session !== null
    if (next !== signedIn) apply((signedIn = next))
  })
}
