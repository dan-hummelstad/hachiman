// High-level client: REST + gateway + a state cache kept current from dispatches. Contract §10.
import { GatewayClient, type GatewayDispatch, type GatewayEventHandlers, type GatewayState } from './gateway'
import { effectivePermissions, type PermissionContext } from './permissions'
import { RestClient, type TokenProvider } from './rest'
import type {
  Channel,
  VoiceStateUpdateRequest,
  Guild,
  GuildFull,
  Member,
  PresenceStatus,
  ReadyPayload,
  Role,
  User,
  VoiceServerUpdate,
  VoiceState,
} from './types'
import { TypedEventEmitter } from './typed-event-emitter'
import { VoiceConnection, type ScreenEncoding } from './voice'

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
  /** guildId → userId → state */
  voiceStates: Map<string, Map<string, VoiceState>>
}

const VOICE_SERVER_TIMEOUT_MS = 15_000

const toGuild = ({ id, name, icon, banner, ownerId, region, createdAt }: Guild): Guild => ({
  id,
  name,
  icon,
  banner,
  ownerId,
  region,
  createdAt,
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
    voiceStates: new Map(),
  }

  private _voice: VoiceConnection | null = null
  private voiceTarget: { guildId: string; channelId: string } | null = null
  /** The user's choices. The wire and media state derive from these (see `selfVoice`). */
  private ownMute = false
  private deafened = false
  private streaming = false
  private cancelPendingJoin: (() => void) | null = null

  constructor(opts: { apiUrl: string; gatewayUrl: string; getToken: TokenProvider }) {
    super()
    this.rest = new RestClient({ baseUrl: opts.apiUrl, getToken: opts.getToken })
    this.gateway = new GatewayClient({ url: opts.gatewayUrl, getToken: opts.getToken })
    this.gateway.on('state', s => this.emit('state', s))
    this.gateway.on('dispatch', e => {
      this.apply(e)
      this.emit('update', e)
      ;(this.emit as (t: string, d: unknown) => boolean)(e.t, e.d)
      if (e.t === 'READY') this.emit('ready', e.d)
    })
  }

  get voice(): VoiceConnection | null {
    return this._voice
  }

  connect(): void {
    this.gateway.connect()
  }

  disconnect(): void {
    this.leaveVoice()
    this.gateway.disconnect()
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
  async joinVoice(guildId: string, channelId: string): Promise<VoiceConnection> {
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

    const vc = new VoiceConnection({
      endpoint: server.endpoint,
      token: server.token,
      iceServers: server.iceServers,
    })
    this.applySelfVoice(vc)
    vc.on('close', () => {
      // Unexpected media drop: leave on the gateway too, else it keeps a stale voice state and a
      // rejoin of the same channel looks like a no-op (no VOICE_SERVER_UPDATE).
      // ponytail: no auto-rejoin; the UI decides (joinVoice again).
      if (this._voice === vc) this.leaveVoice()
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

  private applySelfVoice(vc: VoiceConnection): void {
    const { selfMute, selfDeaf } = this.wireVoice()
    vc.setDeafened(selfDeaf)
    void vc.setMuted(selfMute)
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
    for (const p of g.presences) this.setPresence(p.userId, p.status)
  }

  private removeGuild(guildId: string): void {
    const c = this.cache
    c.guilds.delete(guildId)
    for (const ch of c.channels.values()) if (ch.guildId === guildId) c.channels.delete(ch.id)
    c.roles.delete(guildId)
    c.members.delete(guildId)
    c.voiceStates.delete(guildId)
    if (this.voiceTarget?.guildId === guildId) {
      this.voiceTarget = null
      this.dropVoice()
    }
  }

  private setPresence(userId: string, status: PresenceStatus): void {
    if (status === 'offline') this.cache.presences.delete(userId)
    else this.cache.presences.set(userId, status)
  }

  private apply(e: GatewayDispatch): void {
    const c = this.cache
    switch (e.t) {
      case 'READY':
        // A fresh session invalidates any voice session bound to the old one.
        this.cancelPendingJoin?.()
        this.voiceTarget = null
        this.dropVoice()
        c.user = e.d.user
        for (const m of Object.values(c)) if (m instanceof Map) m.clear()
        for (const g of e.d.guilds) this.ingestGuild(g)
        for (const ch of e.d.privateChannels) c.channels.set(ch.id, ch)
        for (const p of e.d.presences) this.setPresence(p.userId, p.status)
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
        break
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
        this.setPresence(e.d.userId, e.d.status)
        break
      case 'VOICE_STATE_UPDATE':
        // One voice session per user globally: a state anywhere replaces any other.
        for (const states of c.voiceStates.values()) states.delete(e.d.userId)
        if (e.d.channelId) sub(c.voiceStates, e.d.guildId).set(e.d.userId, e.d)
        break
      case 'RESUMED':
      case 'MESSAGE_CREATE':
      case 'MESSAGE_UPDATE':
      case 'MESSAGE_DELETE':
      case 'TYPING_START':
      case 'VOICE_SERVER_UPDATE':
        break // not cached; consumers handle the re-emitted event
    }
  }
}
