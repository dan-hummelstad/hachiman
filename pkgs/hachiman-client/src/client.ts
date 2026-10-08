// High-level client: REST + gateway + a state cache kept current from dispatches. Contract §10.
// The cache holds ciphertext: the shared UI decrypts Message.envelope with @hachiman/crypto.
import { GatewayClient, type GatewayDispatch, type GatewayEventHandlers, type GatewayState } from './gateway'
import { effectivePermissions, type PermissionContext } from './permissions'
import { RestClient, type TokenProvider } from './rest'
import type {
  BlockedUser,
  Channel,
  DeviceProver,
  GatewayDevice,
  VoiceStateUpdateRequest,
  Guild,
  GuildEventWithMe,
  GuildEmoji,
  GuildFull,
  Member,
  PresenceStatus,
  ReadState,
  Presence,
  CustomStatus,
  ReadyPayload,
  Role,
  User,
  VoiceServerUpdate,
  VoiceState,
} from './types'
import { TypedEventEmitter } from './typed-event-emitter'
import { VoiceConnection, type ScreenEncoding, type VoiceE2eeDelegate } from './voice'

export interface HachimanClientOptions {
  apiUrl: string
  gatewayUrl: string
  getToken: TokenProvider
  /** The current device. null: no device yet (onboarding), and `connect()` waits until it is not null. */
  device: () => GatewayDevice | null
  /**
   * Signs DS requests and IDENTIFY/RESUME with the device key (§12.12 "Device proof", §12.13).
   * The shared UI passes the crypto Worker's proveDevice. Without it, no proof goes out.
   */
  proveDevice?: DeviceProver
  /** Called once per `joinVoice`, after VOICE_SERVER_UPDATE. */
  voiceE2ee: () => VoiceE2eeDelegate
}

/** A voice room: a guild voice channel, or a DM / group DM call (`guildId` null, §6 "DM calls"). */
export interface VoiceTarget {
  guildId: string | null
  channelId: string
}

/**
 * The key of a voice state in `HachimanCache.voiceStates`: the guild id, or the DM channel id of a
 * DM call (ids are UUIDs, so the two never collide).
 */
export function voiceScopeId(vs: { guildId: string | null; channelId: string }): string {
  return vs.guildId ?? vs.channelId
}

/** Self mute/deafen as sent in VOICE_STATE_UPDATE. */
export interface SelfVoice {
  selfMute: boolean
  selfDeaf: boolean
}

/**
 * The client's self mute/deafen state. `selfMute`/`selfDeaf` are the wire values; `ownMute` is the
 * user's own mute choice, which undeafen restores (deafen forces `selfMute` on without touching it).
 */
export interface SelfVoiceState extends SelfVoice {
  ownMute: boolean
}

export type HachimanClientEvents = GatewayEventHandlers & {
  /** READY applied to the cache (fresh session; caches were rebuilt). */
  ready: (d: ReadyPayload) => void
  state: (state: GatewayState) => void
  /** Fired after any dispatch has been applied to the cache. */
  update: (e: GatewayDispatch) => void
  /** The active voice connection changed (`null` = left / dropped). */
  voice: (vc: VoiceConnection | null) => void
  /** The gateway closed with 4012 or 4013 and does not reconnect (§12.13). */
  fatal: (e: { code: number }) => void
  /**
   * Media closed the call with 4013 (E2EE resync). The client has left voice. Call `joinVoice`
   * with the same target to rejoin.
   */
  voiceResync: (target: VoiceTarget) => void
  /**
   * A moderator moved the user to `target` (§6 "Voice moderation"). Fires before the old call
   * drops ('voice' null); 'voice' then gives the connection of `target`. Send no op 4 for it.
   */
  voiceMoved: (target: VoiceTarget) => void
}

export interface HachimanCache {
  user: User | null
  guilds: Map<string, Guild>
  /** Guild channels + DMs. */
  channels: Map<string, Channel>
  /** guildId → roleId → Role */
  roles: Map<string, Map<string, Role>>
  /** guildId → userId → Member */
  members: Map<string, Map<string, Member>>
  /** userId → status. Absent ⇒ offline. */
  presences: Map<string, PresenceStatus>
  /** userId → custom status of an online user (§1). Check `expiresAt` when showing it. */
  customStatuses: Map<string, CustomStatus>
  /** `voiceScopeId` (guild id, or DM channel id of a DM call) → userId → state */
  voiceStates: Map<string, Map<string, VoiceState>>
  /** channelId → read state, from READY and READ_STATE_UPDATE (§1 ReadState). */
  readStates: Map<string, ReadState>
  /** guildId → custom emojis, oldest first. From READY / GUILD_CREATE, then GUILD_EMOJIS_UPDATE. */
  emojis: Map<string, GuildEmoji[]>
  /** guildId → eventId → event. Filled by `fetchGuildEvents`, then kept by the GUILD_EVENT_* events. */
  events: Map<string, Map<string, GuildEventWithMe>>
  /** The user ids the current user blocked. Filled by `fetchBlocks`, then kept by USER_BLOCK_UPDATE. */
  blocks: Set<string>
}

const VOICE_SERVER_TIMEOUT_MS = 15_000
/** Media close code: the gateway kicked the session (§8). The gateway already changed the voice state. */
const VOICE_KICKED = 4010
/** How often `connect()` checks for a device while `device()` returns null. */
const DEVICE_POLL_MS = 250

const toGuild = ({
  id,
  name,
  icon,
  banner,
  ownerId,
  region,
  createdAt,
  publicHistoryVisibility,
}: Guild): Guild => ({
  id,
  name,
  icon,
  banner,
  ownerId,
  region,
  createdAt,
  publicHistoryVisibility,
})

function sub<V>(m: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let inner = m.get(key)
  if (!inner) m.set(key, (inner = new Map<string, V>()))
  return inner
}

export class HachimanClient extends TypedEventEmitter<HachimanClientEvents> {
  readonly rest: RestClient
  readonly gateway: GatewayClient
  readonly cache: HachimanCache = {
    user: null,
    guilds: new Map(),
    channels: new Map(),
    roles: new Map(),
    members: new Map(),
    presences: new Map(),
    customStatuses: new Map(),
    voiceStates: new Map(),
    readStates: new Map(),
    emojis: new Map(),
    events: new Map(),
    blocks: new Set(),
  }

  private _voice: VoiceConnection | null = null
  private voiceTarget: VoiceTarget | null = null
  /** Bumped by READY: a fetch that started before it does not fill the new cache. */
  private session = 0
  /** The user's choices. The wire and media state derive from these (see `selfVoice`). */
  private ownMute = false
  private deafened = false
  private streaming = false
  private cancelPendingJoin: (() => void) | null = null
  private wantConnect = false
  private deviceWait: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly opts: HachimanClientOptions) {
    super()
    this.rest = new RestClient({
      baseUrl: opts.apiUrl,
      getToken: opts.getToken,
      getDeviceId: () => opts.device()?.deviceId ?? null,
      proveDevice: opts.proveDevice,
    })
    this.gateway = new GatewayClient({
      url: opts.gatewayUrl,
      getToken: opts.getToken,
      device: () => {
        const device = opts.device()
        if (!device) throw new Error('HachimanClient: no device')
        return device
      },
      proveDevice: opts.proveDevice,
    })
    this.gateway.on('state', s => {
      if (s === 'ready') this.leaveStaleVoice() // before 'state': a rejoin on 'ready' comes after it
      this.emit('state', s)
    })
    this.gateway.on('fatal', e => {
      this.wantConnect = false
      this.leaveVoice()
      this.emit('fatal', e)
    })
    this.gateway.on('dispatch', e => {
      this.apply(e)
      this.followServerVoice(e)
      this.emit('update', e)
      ;(this.emit as (t: string, d: unknown) => boolean)(e.t, e.d)
      if (e.t === 'READY') this.emit('ready', e.d)
    })
  }

  get voice(): VoiceConnection | null {
    return this._voice
  }

  /** Connects the gateway. While `device()` returns null, it waits and checks again. */
  connect(): void {
    this.wantConnect = true
    this.connectWhenDevice()
  }

  disconnect(): void {
    this.wantConnect = false
    clearTimeout(this.deviceWait)
    this.leaveVoice()
    this.gateway.disconnect()
  }

  private connectWhenDevice(): void {
    clearTimeout(this.deviceWait)
    if (!this.wantConnect) return
    if (this.opts.device() === null) {
      this.deviceWait = setTimeout(() => {
        this.connectWhenDevice()
      }, DEVICE_POLL_MS)
      return
    }
    this.gateway.connect()
  }

  /** Current user's effective permissions in a channel (0 if unknown / not visible). */
  permissionsFor(channelId: string): number {
    const channel = this.cache.channels.get(channelId)
    return channel ? effectivePermissions({ ...this.guildContext(channel.guildId), channel }) : 0
  }

  guildPermissions(guildId: string): number {
    return effectivePermissions(this.guildContext(guildId))
  }

  /** Joins with the current `selfVoice`; change it with `setSelfVoice` (before or during the session). */
  /** `guildId` null: the call of a DM or group DM channel (§6 "DM calls"). */
  async joinVoice(guildId: string | null, channelId: string): Promise<VoiceConnection> {
    this.cancelPendingJoin?.()
    this.dropVoice()
    this.voiceTarget = { guildId, channelId }
    this.streaming = false // a share never moves to another channel
    const target = this.voiceTarget

    const server = await new Promise<VoiceServerUpdate>((resolve, reject) => {
      const onUpdate = (d: VoiceServerUpdate) => {
        if (d.guildId !== guildId || d.channelId !== channelId) return
        done()
        resolve(d)
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error('joinVoice: timed out waiting for VOICE_SERVER_UPDATE'))
      }, VOICE_SERVER_TIMEOUT_MS)
      const done = () => {
        clearTimeout(timer)
        this.gateway.off('VOICE_SERVER_UPDATE', onUpdate)
        this.cancelPendingJoin = null
      }
      this.cancelPendingJoin = () => {
        done()
        reject(new Error('joinVoice: superseded'))
      }
      this.gateway.on('VOICE_SERVER_UPDATE', onUpdate)
      this.sendVoiceState()
    })
    return this.connectVoice(target, server)
  }

  /** Opens the media connection of `server` for `target` (the current `voiceTarget`). */
  private async connectVoice(
    target: VoiceTarget,
    server: VoiceServerUpdate,
  ): Promise<VoiceConnection> {
    const { guildId, channelId } = target
    let e2ee: VoiceE2eeDelegate
    try {
      e2ee = this.opts.voiceE2ee() // one delegate per call; the connection closes it
    } catch (err) {
      if (this.voiceTarget === target) this.leaveVoice()
      throw err
    }
    const vc = new VoiceConnection({
      endpoint: server.endpoint,
      token: server.token,
      iceServers: server.iceServers,
      e2ee,
    })
    this.applySelfVoice(vc)
    vc.on('resync', () => {
      if (this._voice === vc) this.emit('voiceResync', { guildId, channelId })
    })
    vc.on('close', e => {
      if (this._voice !== vc) return
      if (e.code === VOICE_KICKED) {
        // The gateway ended or moved the call (a disconnect or move by a moderator, or a join from
        // another device). Its voice state is already right: an op 4 leave here would undo a move.
        this.voiceTarget = null
        this.streaming = false
        this.dropVoice()
        return
      }
      // Unexpected media drop: leave on the gateway too, else it keeps a stale voice state and a
      // rejoin of the same channel looks like a no-op (no VOICE_SERVER_UPDATE).
      // ponytail: no auto-rejoin; the UI decides (joinVoice again).
      this.leaveVoice()
    })
    this._voice = vc
    this.emit('voice', vc)
    try {
      await vc.connect()
    } catch (err) {
      if (this._voice === vc && this.voiceTarget === target) this.leaveVoice()
      throw err
    }
    if (this._voice !== vc) throw new Error('joinVoice: superseded')
    return vc
  }

  leaveVoice(): void {
    this.cancelPendingJoin?.()
    const target = this.voiceTarget
    this.voiceTarget = null
    this.streaming = false
    if (target)
      this.gateway.updateVoiceState({ ...this.wireVoice(), guildId: target.guildId, channelId: null })
    this.dropVoice()
  }

  /**
   * After a RESUME, the gateway may still hold a call of this session that the client dropped
   * (its leave went out while the socket was down). Leave it, else a rejoin of that channel looks
   * like a mute toggle and gets no VOICE_SERVER_UPDATE.
   */
  private leaveStaleVoice(): void {
    const me = this.cache.user?.id
    const session = this.gateway.sessionId
    if (this.voiceTarget || !me || !session) return
    for (const states of this.cache.voiceStates.values()) {
      const mine = states.get(me)
      if (mine?.sessionId === session)
        this.gateway.updateVoiceState({ ...this.wireVoice(), guildId: mine.guildId, channelId: null })
    }
  }

  /** Deafen implies mute, so `selfMute` is true while deafened even if the user never muted. */
  get selfVoice(): SelfVoiceState {
    const { selfMute, selfDeaf } = this.wireVoice()
    return { ownMute: this.ownMute, selfMute, selfDeaf }
  }

  /**
   * The one place self mute/deafen policy lives (Discord semantics):
   * - deafen mutes sending and local playback; undeafen restores the prior explicit mute;
   * - unmuting while deafened also undeafens.
   * Applies to the live connection (mute gates the outgoing track; the caller keeps its mic stream)
   * and sends exactly one VOICE_STATE_UPDATE when in voice. Works outside voice too: the next
   * `joinVoice` uses it.
   */
  setSelfVoice(change: Partial<SelfVoice>): SelfVoiceState {
    if (change.selfMute !== undefined) {
      this.ownMute = change.selfMute
      if (!change.selfMute) this.deafened = false
    }
    if (change.selfDeaf !== undefined) this.deafened = change.selfDeaf
    if (this._voice) this.applySelfVoice(this._voice)
    this.sendVoiceState()
    return this.selfVoice
  }

  /**
   * Sets my custom status (§6 op 3); an empty `text` clears it. The cache changes when the
   * gateway echoes PRESENCE_UPDATE. Dropped while the gateway is not connected.
   */
  setCustomStatus(text: string, expiresAt: string | null = null): void {
    this.gateway.setCustomStatus(text, expiresAt)
  }

  /**
   * Sends `track` as my screen share (`null` stops it) and sets `selfStream` to match. Outside
   * voice it does nothing; leaving voice or joining another channel ends the share. A new
   * `encoding` for the live track sends no VOICE_STATE_UPDATE. The caller owns the track.
   */
  async setScreen(track: MediaStreamTrack | null, encoding: ScreenEncoding | null = null): Promise<void> {
    const vc = this._voice
    if (!vc) return
    const streaming = track !== null
    if (streaming !== this.streaming) {
      this.streaming = streaming
      this.sendVoiceState()
    }
    await vc.setScreen(track, encoding)
  }

  /**
   * Server mute and deafen of the current user in the guild of the call (§6 "Voice moderation"),
   * from the voice state and the member. They gate the media like self mute and deafen, but the
   * user cannot lift them, and op 4 does not carry them.
   */
  get serverVoice(): { mute: boolean; deaf: boolean } {
    const me = this.cache.user?.id
    const guildId = this.voiceTarget?.guildId
    if (!me || !guildId) return { mute: false, deaf: false }
    const state = this.cache.voiceStates.get(guildId)?.get(me)
    const member = this.cache.members.get(guildId)?.get(me)
    return { mute: !!(state?.mute ?? member?.mute), deaf: !!(state?.deaf ?? member?.deaf) }
  }

  private applySelfVoice(vc: VoiceConnection): void {
    const { selfMute, selfDeaf } = this.wireVoice()
    const server = this.serverVoice
    vc.setDeafened(selfDeaf || server.deaf)
    void vc.setMuted(selfMute || server.mute || server.deaf)
  }

  /**
   * Follows the gateway when it changes the call (§6 "Voice moderation"): a server mute or deafen
   * of the current user gates the media now, and a move (VOICE_SERVER_UPDATE with `moved`) opens
   * the media connection of the new channel without an op 4.
   */
  private followServerVoice(e: GatewayDispatch): void {
    const me = this.cache.user?.id
    if (!me) return
    if (
      (e.t === 'VOICE_STATE_UPDATE' && e.d.userId === me) ||
      (e.t === 'GUILD_MEMBER_UPDATE' && e.d.user.id === me)
    ) {
      if (this._voice) this.applySelfVoice(this._voice)
      return
    }
    if (e.t !== 'VOICE_SERVER_UPDATE' || !e.d.moved || this.cancelPendingJoin) return
    const server = e.d
    const target = { guildId: server.guildId, channelId: server.channelId }
    this.emit('voiceMoved', target)
    this.dropVoice()
    this.voiceTarget = target
    this.streaming = false
    this.connectVoice(target, server).catch((err: unknown) => {
      console.warn('HachimanClient: voice move failed', err)
    })
  }

  private sendVoiceState(): void {
    if (this.voiceTarget) this.gateway.updateVoiceState({ ...this.wireVoice(), ...this.voiceTarget })
  }

  private wireVoice(): Omit<VoiceStateUpdateRequest, 'guildId' | 'channelId'> {
    return {
      selfMute: this.ownMute || this.deafened,
      selfDeaf: this.deafened,
      selfStream: this.streaming,
    }
  }

  private dropVoice(): void {
    const vc = this._voice
    if (!vc) return
    this._voice = null
    vc.close()
    this.emit('voice', null)
  }

  /** The current user's standing in `guildId` from the cache (empty for DMs). */
  private guildContext(guildId: string | null): PermissionContext {
    if (guildId === null) return {}
    const me = this.cache.user
    return {
      guild: this.cache.guilds.get(guildId),
      member: me ? this.cache.members.get(guildId)?.get(me.id) : undefined,
      roles: this.cache.roles.get(guildId),
    }
  }

  private ingestGuild(g: GuildFull): void {
    const c = this.cache
    c.guilds.set(g.id, toGuild(g))
    for (const ch of c.channels.values()) if (ch.guildId === g.id) c.channels.delete(ch.id)
    for (const ch of g.channels) c.channels.set(ch.id, ch)
    c.roles.set(g.id, new Map(g.roles.map(r => [r.id, r])))
    c.members.set(g.id, new Map(g.members.map(m => [m.user.id, m])))
    c.voiceStates.set(g.id, new Map(g.voiceStates.filter(v => v.channelId).map(v => [v.userId, v])))
    for (const p of g.presences) this.setPresence(p)
    c.emojis.set(g.id, g.emojis ?? [])
  }

  /** Loads the upcoming and ongoing events of a guild into `cache.events`. */
  async fetchGuildEvents(guildId: string): Promise<GuildEventWithMe[]> {
    const started = this.session
    const events = await this.rest.getGuildEvents(guildId)
    // A READY or GUILD_DELETE meanwhile: the guild of this list is not in the cache any more.
    if (started === this.session && this.cache.guilds.has(guildId))
      this.cache.events.set(guildId, new Map(events.map(ev => [ev.id, ev])))
    return events
  }

  /** Loads the blocked user ids into `cache.blocks`. Resolves the list with the users. */
  async fetchBlocks(): Promise<BlockedUser[]> {
    const started = this.session
    const blocks = await this.rest.getBlocks()
    if (started === this.session) {
      this.cache.blocks.clear()
      for (const b of blocks) this.cache.blocks.add(b.user.id)
    }
    return blocks
  }

  private removeGuild(guildId: string): void {
    const c = this.cache
    c.guilds.delete(guildId)
    for (const ch of c.channels.values())
      if (ch.guildId === guildId) {
        c.channels.delete(ch.id)
        c.readStates.delete(ch.id)
      }
    c.roles.delete(guildId)
    c.members.delete(guildId)
    c.voiceStates.delete(guildId)
    c.events.delete(guildId)
    c.emojis.delete(guildId)
    if (this.voiceTarget?.guildId === guildId) {
      this.voiceTarget = null
      this.dropVoice()
    }
  }

  private setPresence({ userId, status, customStatus }: Presence): void {
    if (status === 'offline') this.cache.presences.delete(userId)
    else this.cache.presences.set(userId, status)
    if (status === 'offline' || !customStatus) this.cache.customStatuses.delete(userId)
    else this.cache.customStatuses.set(userId, customStatus)
  }

  private apply(e: GatewayDispatch): void {
    const c = this.cache
    switch (e.t) {
      case 'READY':
        this.session++
        // A fresh session invalidates any voice session bound to the old one.
        this.cancelPendingJoin?.()
        this.voiceTarget = null
        this.dropVoice()
        c.user = e.d.user
        for (const m of Object.values(c)) if (m instanceof Map || m instanceof Set) m.clear()
        for (const g of e.d.guilds) this.ingestGuild(g)
        for (const ch of e.d.privateChannels) c.channels.set(ch.id, ch)
        for (const vs of e.d.privateVoiceStates ?? [])
          if (vs.channelId) sub(c.voiceStates, voiceScopeId({ ...vs, channelId: vs.channelId })).set(vs.userId, vs)
        for (const p of e.d.presences) this.setPresence(p)
        for (const r of e.d.readStates ?? []) c.readStates.set(r.channelId, r)
        break
      case 'GUILD_CREATE':
        this.ingestGuild(e.d)
        break
      case 'GUILD_UPDATE':
        c.guilds.set(e.d.id, toGuild(e.d))
        break
      case 'GUILD_DELETE':
        this.removeGuild(e.d.id)
        break
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
        c.channels.set(e.d.id, e.d)
        break
      case 'CHANNEL_DELETE':
        c.channels.delete(e.d.id)
        c.readStates.delete(e.d.id)
        if (e.d.guildId === null) c.voiceStates.delete(e.d.id) // the call of a DM
        break
      case 'READ_STATE_UPDATE': {
        // The ack moved forward. Messages after it that arrived since READY are not counted here.
        const prev = c.readStates.get(e.d.channelId)
        c.readStates.set(e.d.channelId, {
          channelId: e.d.channelId,
          lastReadMessageId: e.d.lastReadMessageId,
          unreadCount: 0,
          lastMessageId: prev?.lastMessageId ?? e.d.lastReadMessageId,
        })
        break
      }
      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_UPDATE':
        sub(c.members, e.d.guildId).set(e.d.user.id, e.d)
        break
      case 'GUILD_MEMBER_REMOVE':
        c.members.get(e.d.guildId)?.delete(e.d.user.id)
        c.voiceStates.get(e.d.guildId)?.delete(e.d.user.id)
        break
      case 'USER_UPDATE':
        c.user = e.d
        break
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE':
        sub(c.roles, e.d.guildId).set(e.d.role.id, e.d.role)
        break
      case 'GUILD_ROLE_DELETE': {
        c.roles.get(e.d.guildId)?.delete(e.d.roleId)
        const members = c.members.get(e.d.guildId)
        // The server sends no member updates for this; strip the dangling role id locally.
        for (const [id, m] of members ?? [])
          if (m.roles.includes(e.d.roleId))
            members?.set(id, { ...m, roles: m.roles.filter(r => r !== e.d.roleId) })
        break
      }
      case 'PRESENCE_UPDATE':
        this.setPresence(e.d)
        break
      case 'VOICE_STATE_UPDATE':
        // One voice session per user globally: a state anywhere replaces any other.
        for (const states of c.voiceStates.values()) states.delete(e.d.userId)
        if (e.d.channelId) sub(c.voiceStates, voiceScopeId({ ...e.d, channelId: e.d.channelId })).set(e.d.userId, e.d)
        break
      case 'GUILD_EMOJIS_UPDATE':
        if (c.guilds.has(e.d.guildId)) c.emojis.set(e.d.guildId, e.d.emojis)
        break
      case 'GUILD_EVENT_CREATE':
      case 'GUILD_EVENT_UPDATE': {
        const events = c.events.get(e.d.guildId)
        // Not loaded yet: fetchGuildEvents gets the full list later.
        if (events) events.set(e.d.id, { ...e.d, me: events.get(e.d.id)?.me ?? false })
        break
      }
      case 'GUILD_EVENT_DELETE':
        c.events.get(e.d.guildId)?.delete(e.d.id)
        break
      case 'GUILD_EVENT_RSVP': {
        const events = c.events.get(e.d.guildId)
        const ev = events?.get(e.d.eventId)
        if (events && ev) {
          const me = e.d.userId === c.user?.id ? e.d.going : ev.me
          events.set(ev.id, { ...ev, rsvpCount: e.d.rsvpCount, me })
        }
        break
      }
      case 'USER_BLOCK_UPDATE':
        if (e.d.blocked) c.blocks.add(e.d.userId)
        else c.blocks.delete(e.d.userId)
        break
      case 'RESUMED':
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE':
      case 'MESSAGE_DELETE':
      case 'TYPING_START':
      case 'VOICE_SERVER_UPDATE':
      case 'CALL_RING':
      case 'MLS_HANDSHAKE':
      case 'MLS_GROUP_UPDATE':
      case 'MLS_BATCH_ASSIGN':
      case 'MLS_JOIN_UPDATE':
      case 'DEVICE_INBOX':
      case 'DEVICE_LINK':
      case 'USER_KEYS_UPDATE':
      case 'KEY_PACKAGES_LOW':
      case 'KT_TREE_HEAD':
      case 'PAGE_CREATE':
      case 'PAGE_UPDATE':
      case 'PAGE_DELETE':
      case 'DOC_UPDATE':
      case 'DOC_AWARENESS':
      case 'INVITE_DELETE':
      case 'CHANNEL_PINS_UPDATE':
      case 'GUILD_SOUNDS_UPDATE':
      case 'POKE':
        break // not cached; consumers (the crypto Worker for the §12.13 events, the shared UI DocsService for pages, the invite list, the pins popover, the soundboard, the poke toast) handle the re-emitted event
    }
  }
}
