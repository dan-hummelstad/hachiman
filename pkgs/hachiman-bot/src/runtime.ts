/**
 * The bot runtime: one Hachiman E2EE client in Node (docs/bots-plan.md §3). It holds the bot's
 * keys in a state directory, as the desktop app holds a user's keys in its crypto Worker:
 *
 * - `HachimanClient` (@hachiman/client) for REST and the gateway, with the bot token as the bearer.
 * - The @hachiman/crypto engine in-process (`@hachiman/crypto/host`), with `FileCryptoStore`.
 * - The app's DS transport (`@hachiman/hachiman/ds-transport`) over the client's REST and cache.
 *
 * It gives plaintext events (`message`, `messageUpdate`, `messageDelete`, `reaction`) and
 * plaintext calls (`send`, `edit`, `delete`, `react`, `fetchMessages`). Every other gateway event
 * comes out of `event` after the client cache took it. The Discord bridge (src/discord) sits on top.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HachimanClient,
  RestError,
  TypedEventEmitter,
  type Channel,
  type HachimanCache,
  type Message,
  type User,
} from '@hachiman/client'
import {
  CryptoError,
  type CryptoApi,
  type CryptoEvents,
  type CryptoGatewayEvent,
  type CryptoStatus,
  type DecryptResult,
  type EncryptMessageInput,
  type Mention,
} from '@hachiman/crypto'
import { E2EE_CAPABILITY, LINK_QR_PREFIX } from '@hachiman/crypto/constants'
import { clientPermissions, createEngine } from '@hachiman/crypto/host'
import { createDsTransport } from '@hachiman/hachiman/ds-transport'
import { shardOfGuild } from './ids'
import { botApi, ensureDeploymentKey, openLinkPayload, readDeploymentKey, sealLinkPayload } from './link'
import { FileCryptoStore } from './store'

export const BOT_CLIENT_VERSION = '0.1.0'

export interface BotRuntimeOptions {
  /** The bot token from the Takusen dashboard (`hbot_…`). */
  token: string
  /** Takusen REST base, e.g. `https://chat.example.com/api/v1`. Absolute. */
  apiUrl: string
  /** Gateway, e.g. `wss://gateway.example.com/gateway`. */
  gatewayUrl: string
  /** The keys of this device and its recovery key. Keep it: a lost directory is a new device. */
  stateDir: string
  /**
   * Where `deployment.key` lives, shared by the devices of the deployment (all shards on one
   * machine). Default: `stateDir`.
   */
  deploymentDir?: string
  /** Discord sharding: this device serves the guilds of these shards, and DMs when it has shard 0. */
  shard?: { ids: number[]; count: number }
  /** Invite codes to redeem on start (the way a bot joins a guild, docs/bots-plan.md §7). */
  join?: string[]
  log?: (msg: string) => void
}

/** A decrypted chat message. */
export interface BotMessage {
  id: string
  channelId: string
  guildId: string | null
  author: User
  content: string
  mentions: Mention[]
  /** The server id of the message that this one answers, when this runtime knows it. */
  replyTo: string | null
  createdAt: string
  editedAt: string | null
  /** §12.8: edits and reactions name a message by it. */
  clientMsgId: string
}

export interface BotReaction {
  channelId: string
  guildId: string | null
  messageId: string
  userId: string
  emoji: string
  remove: boolean
}

export type BotRuntimeEvents = {
  ready: (user: User) => void
  message: (m: BotMessage) => void
  messageUpdate: (m: BotMessage) => void
  messageDelete: (d: { id: string; channelId: string; guildId: string | null }) => void
  reaction: (r: BotReaction) => void
  /** The Hachiman gateway events in FORWARDED, after the client cache took them. */
  event: (e: { t: string; d: unknown }) => void
  error: (e: Error) => void
}

/** The Hachiman gateway events that `event` carries (after the client cache took them). */
const FORWARDED = [
  'GUILD_CREATE',
  'GUILD_UPDATE',
  'GUILD_DELETE',
  'CHANNEL_CREATE',
  'CHANNEL_UPDATE',
  'CHANNEL_DELETE',
  'GUILD_MEMBER_ADD',
  'GUILD_MEMBER_UPDATE',
  'GUILD_MEMBER_REMOVE',
  'GUILD_ROLE_CREATE',
  'GUILD_ROLE_UPDATE',
  'GUILD_ROLE_DELETE',
  'TYPING_START',
  'PRESENCE_UPDATE',
  'USER_UPDATE',
] as const

/** How often a running device looks for link requests of new devices. */
const LINK_POLL_MS = 5_000
/** A link session lives 10 minutes (§12.5): a new device opens a new one after that. */
const LINK_WAIT_MS = 10 * 60_000

const SEND_ATTEMPTS = 4
const RETRY_BASE_MS = 300
/** Decrypted messages kept per channel, for edits, replies and reactions. */
const KEEP_PER_CHANNEL = 500

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** The group moved on or is not active yet: catch up, then encrypt again (§12.8.3). */
function retryable(e: unknown): boolean {
  const code = e instanceof RestError ? e.code : e instanceof CryptoError ? (e.dsCode ?? e.code) : null
  return (
    code === 'StaleEpoch' || code === 'GroupPending' || code === 'EpochConflict' || code === 'PendingRemoves'
  )
}

/** The §12.8.5 input of one row. */
const toEncrypted = (m: Message) => ({
  id: m.id,
  channelId: m.channelId,
  guildId: m.guildId,
  authorId: m.author.id,
  senderDevice: m.senderDevice,
  groupId: m.groupId,
  epoch: m.epoch,
  clientMsgId: m.clientMsgId,
  envelope: m.envelope,
  attachments: m.attachments.map(a => ({ id: a.id, size: a.size })),
  createdAt: m.createdAt,
  editedAt: m.editedAt,
})

/** The wrap key of the store: 32 random bytes in `wrap.key`, made on the first start. */
async function loadWrapKey(dir: string): Promise<CryptoKey> {
  const path = join(dir, 'wrap.key')
  let raw: Uint8Array<ArrayBuffer>
  try {
    raw = Uint8Array.from(await readFile(path))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    raw = crypto.getRandomValues(new Uint8Array(32))
    await writeFile(path, raw, { mode: 0o600, flag: 'wx' })
  }
  if (raw.length !== 32) throw new Error(`${path}: not a 32-byte key`)
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

/** Per channel: message id → message, and client_msg_id → message id, newest last. */
class History {
  private byChannel = new Map<string, Map<string, BotMessage>>()
  private byClientId = new Map<string, string>()

  put(m: BotMessage): void {
    let ch = this.byChannel.get(m.channelId)
    if (!ch) this.byChannel.set(m.channelId, (ch = new Map()))
    ch.delete(m.id)
    ch.set(m.id, m)
    this.byClientId.set(`${m.channelId}:${m.clientMsgId}`, m.id)
    if (ch.size > KEEP_PER_CHANNEL) {
      const [oldest] = ch.values()
      if (oldest) {
        ch.delete(oldest.id)
        this.byClientId.delete(`${oldest.channelId}:${oldest.clientMsgId}`)
      }
    }
  }
  get(channelId: string, id: string): BotMessage | undefined {
    return this.byChannel.get(channelId)?.get(id)
  }
  idOf(channelId: string, clientMsgId: string): string | null {
    return this.byClientId.get(`${channelId}:${clientMsgId}`) ?? null
  }
  drop(channelId: string, id: string): void {
    const m = this.byChannel.get(channelId)?.get(id)
    if (!m) return
    this.byChannel.get(channelId)?.delete(id)
    this.byClientId.delete(`${channelId}:${m.clientMsgId}`)
  }
}

export class BotRuntime extends TypedEventEmitter<BotRuntimeEvents> {
  readonly client: HachimanClient
  private api: CryptoApi | null = null
  private deviceId: string | null = null
  private deviceToken: string | null = null
  /** The identity of this device is ready: gateway events go to the engine. */
  private identityReady = false
  private connected = false
  private gatewayReady: Promise<void> | null = null
  private readonly linkWaiters = new Map<string, (ok: boolean) => void>()
  private readonly seenLinkRequests = new Set<string>()
  private linkTimer: ReturnType<typeof setInterval> | null = null
  private deploymentKey: CryptoKey | null = null
  /** The owner that this bot pinned on its first start: only they approve a device by DM. */
  private owner: string | null = null
  private readonly history = new History()
  /** Rows that wait for keys, by group (§12.8.5 'pending'). */
  private readonly pending = new Map<string, Map<string, { message: Message; isUpdate: boolean }>>()
  private readonly joined = new Set<string>()
  private readonly log: (msg: string) => void

  constructor(private readonly opts: BotRuntimeOptions) {
    super()
    this.log = opts.log ?? (m => console.log(`[hachiman-bot] ${m}`))
    this.client = new HachimanClient({
      apiUrl: opts.apiUrl,
      gatewayUrl: opts.gatewayUrl,
      // The device token of this device (one grant per device, §12.12); the bot token only mints it.
      getToken: () => Promise.resolve(this.deviceToken ?? opts.token),
      // During onboarding the DS routes need the pending device too (§12.12): the id comes from
      // the engine's status events as soon as the device row exists.
      device: () =>
        this.deviceId
          ? {
              deviceId: this.deviceId,
              capabilities: [E2EE_CAPABILITY],
              clientVersion: BOT_CLIENT_VERSION,
            }
          : null,
      proveDevice: req => this.crypto().proveDevice(req),
      voiceE2ee: () => {
        throw new Error('bots do not join voice')
      },
    })
  }

  get cache(): HachimanCache {
    return this.client.cache
  }

  get user(): User | null {
    return this.client.cache.user
  }

  private crypto(): CryptoApi {
    if (!this.api) throw new Error('the bot runtime is not started')
    return this.api
  }

  private get deploymentDir(): string {
    return this.opts.deploymentDir ?? this.opts.stateDir
  }

  /** Connects once; resolves on the first READY. */
  private connect(): Promise<void> {
    if (!this.gatewayReady) {
      this.gatewayReady = new Promise(resolve => this.client.once('ready', () => resolve()))
      this.connected = true
      this.client.connect()
    }
    return this.gatewayReady
  }

  /**
   * Opens the key store; makes the bot identity on the first start, or links this device to the
   * running devices of the bot; connects; joins `opts.join`.
   */
  async start(): Promise<User> {
    const { stateDir } = this.opts
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    await mkdir(this.deploymentDir, { recursive: true, mode: 0o700 })
    const wrapKey = await loadWrapKey(stateDir)
    const bot = botApi(this.opts.apiUrl, this.opts.token)
    this.deviceToken = await this.loadDeviceToken(bot)
    const me = await this.client.rest.getMe().catch(async (e: unknown) => {
      // The owner reset the token: the device token went with it. A new one binds this device again.
      if (!(e instanceof RestError && e.status === 401)) throw e
      this.deviceToken = await this.loadDeviceToken(bot, true)
      return this.client.rest.getMe()
    })
    if (!me.bot) this.log(`warning: ${me.username} is not a bot account`)
    this.owner = await this.pinOwner(await bot.owner())

    const engine = createEngine({
      transport: createDsTransport(this.client.rest, this.client.cache),
      emit: (event, payload) => this.onCryptoEvent(event, payload),
      adminPermissions: clientPermissions,
      store: new FileCryptoStore(stateDir),
    })
    this.api = engine.api
    let status = await this.api.init({
      userId: me.id,
      wrapKey,
      platform: 'browser',
      clientVersion: BOT_CLIENT_VERSION,
      deviceName: this.opts.shard ? `Bot shard ${this.opts.shard.ids.join(',')}` : 'Bot',
      origin: new URL(this.opts.apiUrl).origin,
    })
    this.deviceId = status.deviceId
    this.forwardGatewayEvents()
    status = await this.onboard(status, me.id)
    this.deviceId = status.deviceId
    this.identityReady = true

    await this.connect()
    await this.crypto()
      .sync()
      .catch((e: unknown) => this.log(`crypto sync failed: ${String(e)}`))
    this.joinReadableChannels()
    // The first device of the deployment makes the deployment key; the others find it.
    const { key, made } = await ensureDeploymentKey(this.deploymentDir)
    this.deploymentKey = key
    if (made)
      this.log(
        `made ${join(this.deploymentDir, 'deployment.key')}. Copy it to each machine that runs this bot: new shards link with it.`,
      )
    this.linkTimer = setInterval(() => void this.serveLinkRequests(me.id), LINK_POLL_MS)
    void this.serveLinkRequests(me.id)

    for (const code of this.opts.join ?? []) await this.joinInvite(code)
    const user = this.client.cache.user ?? me
    this.emit('ready', user)
    return user
  }

  /** The device token in `device.token`, minted with the bot token on the first start of this device. */
  private async loadDeviceToken(bot: ReturnType<typeof botApi>, renew = false): Promise<string> {
    const path = join(this.opts.stateDir, 'device.token')
    if (!renew) {
      const saved = await readFile(path, 'utf8').then(
        s => s.trim() || null,
        () => null,
      )
      if (saved) return saved
    }
    const token = await bot.mintDeviceToken()
    await writeFile(path, `${token}\n`, { mode: 0o600 })
    return token
  }

  /** The owner from the server, checked against the one pinned on the first start (TOFU). */
  private async pinOwner(ownerId: string): Promise<string | null> {
    const path = join(this.deploymentDir, 'owner')
    const pinned = await readFile(path, 'utf8').then(
      s => s.trim() || null,
      () => null,
    )
    if (!pinned) {
      await writeFile(path, `${ownerId}\n`, { mode: 0o600 })
      return ownerId
    }
    if (pinned === ownerId) return pinned
    this.log(
      `warning: the server names another owner than the one pinned in ${path}. Link codes by DM are off.`,
    )
    return null
  }

  /**
   * A device with no identity: make it (a new bot), restore it from a saved recovery key, or link
   * this device to a running device of the bot (contract §4 Bots "Device linking").
   */
  private async onboard(status: CryptoStatus, userId: string): Promise<CryptoStatus> {
    const api = this.crypto()
    const recoveryPath = join(this.opts.stateDir, 'recovery-key.txt')
    if (status.state === 'revoked')
      throw new Error(`this bot device was revoked. Delete ${this.opts.stateDir} to register a new device.`)
    if (status.state === 'ready') return status
    const saved = await readFile(recoveryPath, 'utf8').then(
      s => s.trim() || null,
      () => null,
    )
    if (saved) {
      this.log('restoring the bot identity from the saved recovery key')
      return api.restoreFromRecoveryKey(saved)
    }
    if (status.state === 'needs_identity') {
      // A first start, or the first start after the owner reset the bot's keys: resetIdentity
      // makes generation 1, or the next generation after a reset (§12.4 "Password reset"). It
      // refuses while the bot has a current master key: then this device links instead.
      try {
        const first = await api.resetIdentity()
        await writeFile(recoveryPath, `${first.recoveryKey}\n`, { mode: 0o600 })
        this.log(`made the bot identity. Its recovery key is in ${recoveryPath}.`)
        return first.status
      } catch (e) {
        // 'Unsupported': the bot has a current master key. 'MasterKeyExists': another shard of a
        // new bot made it first, at the same time. Either way this device links.
        const exists =
          e instanceof CryptoError && (e.code === 'Unsupported' || e.dsCode === 'MasterKeyExists')
        if (!exists) throw e
      }
    }
    return this.linkAsNewDevice(userId)
  }

  /**
   * The bot has keys on other devices: open a QR link session (§12.5), give its payload to the
   * running devices (sealed in the link mailbox, or by the owner in a DM), and wait for the
   * transfer. A new session after each expiry.
   */
  private async linkAsNewDevice(userId: string): Promise<CryptoStatus> {
    const api = this.crypto()
    // The link messages come as DEVICE_LINK events, with this pending device on the gateway.
    void this.connect()
    const keyPath = join(this.deploymentDir, 'deployment.key')
    for (;;) {
      const start = await api.linkAsNewDevice('qr')
      if (!start.qrPayload) throw new Error('the link session has no QR payload')
      const done = new Promise<boolean>(resolve => {
        this.linkWaiters.set(start.sessionId, resolve)
        setTimeout(() => resolve(false), LINK_WAIT_MS)
      })
      // A shard that starts with the first one finds the deployment key once the first one made it.
      let posted = false
      let told = false
      let settled: boolean | null = null
      void done.then(ok => (settled = ok))
      while (settled === null && !posted) {
        const key = await readDeploymentKey(this.deploymentDir)
        if (key) {
          await botApi(this.opts.apiUrl, this.opts.token).postLinkRequest(
            await sealLinkPayload(key, userId, start.qrPayload),
          )
          this.log('this bot has keys on other devices: waiting for a running device to link this one')
          posted = true
        } else {
          if (!told)
            this.log(
              `this bot has keys on other devices, and ${keyPath} is not here. Copy it from a running instance, ` +
                `or have the owner send the bot this code in a DM (valid 10 minutes):\n${start.qrPayload}`,
            )
          told = true
          await sleep(2000)
        }
      }
      const ok = await done
      this.linkWaiters.delete(start.sessionId)
      if (ok) {
        this.log('linked this device')
        return api.status()
      }
      await api.linkCancel(start.sessionId).catch(() => undefined)
    }
  }

  /** A running device: link the new devices of this bot that the deployment key vouches for. */
  private async serveLinkRequests(userId: string): Promise<void> {
    const key = this.deploymentKey
    if (!key) return
    let requests: { id: string; blob: string }[]
    try {
      requests = await botApi(this.opts.apiUrl, this.opts.token).linkRequests()
    } catch (e) {
      return this.log(`reading link requests failed: ${String(e)}`)
    }
    for (const r of requests) {
      if (this.seenLinkRequests.has(r.id)) continue
      this.seenLinkRequests.add(r.id)
      const payload = await openLinkPayload(key, userId, r.blob)
      if (!payload) continue // another deployment key: not ours to link
      await this.linkDevice(payload)
    }
  }

  private async linkDevice(payload: string): Promise<string | null> {
    try {
      const { newDeviceName } = await this.crypto().linkScan(payload)
      this.log(`linking a new device: ${newDeviceName}`)
      return newDeviceName
    } catch (e) {
      // Another running shard may have linked it first.
      this.log(`linking a new device failed: ${String(e)}`)
      return null
    }
  }

  /** A link code that the pinned owner sent this bot in a DM (contract §4 Bots "Device linking"). */
  private isOwnerLinkCode(m: BotMessage): boolean {
    return (
      m.guildId === null &&
      this.owner !== null &&
      m.author.id === this.owner &&
      m.content.trim().startsWith(LINK_QR_PREFIX)
    )
  }

  private async approveByOwner(m: BotMessage): Promise<void> {
    const name = await this.linkDevice(m.content.trim())
    await this.send(m.channelId, {
      text: name
        ? `Linked the new device "${name}".`
        : 'That link code did not work. It may have expired: start the new device again.',
    }).catch((e: unknown) => this.log(`replying to the owner failed: ${String(e)}`))
  }

  /** A bot device serves the guilds of its shards (Discord's formula), and DMs on shard 0. */
  private owns(guildId: string | null): boolean {
    const shard = this.opts.shard
    if (!shard) return true
    if (guildId === null) return shard.ids.includes(0)
    const g = this.client.cache.guilds.get(guildId)
    return g ? shard.ids.includes(shardOfGuild(g.createdAt, shard.count)) : false
  }

  stop(): void {
    if (this.linkTimer) clearInterval(this.linkTimer)
    this.linkTimer = null
    if (this.connected) this.client.disconnect()
  }

  // MARK: - Gateway → engine and plaintext events

  private forwardGatewayEvents(): void {
    const c = this.client
    const fwd = (event: CryptoGatewayEvent): void => {
      // Before the identity is ready, only the link of this device runs (as the app does).
      if (!this.identityReady && event.t !== 'DEVICE_LINK') return
      this.crypto()
        .onGatewayEvent(event)
        .catch((e: unknown) => this.log(`crypto event ${event.t} failed: ${String(e)}`))
    }
    c.on('MLS_HANDSHAKE', d => fwd({ t: 'MLS_HANDSHAKE', d }))
    c.on('MLS_BATCH_ASSIGN', d => fwd({ t: 'MLS_BATCH_ASSIGN', d }))
    c.on('MLS_JOIN_UPDATE', d => fwd({ t: 'MLS_JOIN_UPDATE', d }))
    c.on('MLS_GROUP_UPDATE', d => fwd({ t: 'MLS_GROUP_UPDATE', d }))
    c.on('DEVICE_INBOX', d => fwd({ t: 'DEVICE_INBOX', d }))
    c.on('DEVICE_LINK', d => fwd({ t: 'DEVICE_LINK', d }))
    c.on('USER_KEYS_UPDATE', d => fwd({ t: 'USER_KEYS_UPDATE', d }))
    c.on('KEY_PACKAGES_LOW', d => fwd({ t: 'KEY_PACKAGES_LOW', d }))
    c.on('KT_TREE_HEAD', d => fwd({ t: 'KT_TREE_HEAD', d }))
    c.on('INVITE_DELETE', d => fwd({ t: 'INVITE_DELETE', d }))

    const sync = (): void => {
      if (!this.identityReady) return
      this.crypto()
        .sync()
        .then(() => this.joinReadableChannels())
        .catch((e: unknown) => this.log(`crypto sync failed: ${String(e)}`))
    }
    c.on('READY', sync)
    c.on('RESUMED', sync)
    c.on('GUILD_CREATE', () => this.joinReadableChannels())
    c.on('CHANNEL_CREATE', () => this.joinReadableChannels())
    c.on('MESSAGE_CREATE', m => {
      if (this.identityReady && this.owns(m.guildId)) void this.ingest([m], false)
    })
    c.on('MESSAGE_UPDATE', m => {
      if (this.identityReady && this.owns(m.guildId)) void this.ingest([m], true)
    })
    c.on('MESSAGE_DELETE', d => {
      this.history.drop(d.channelId, d.id)
      for (const rows of this.pending.values()) rows.delete(d.id)
      this.emit('messageDelete', d)
    })
    for (const t of FORWARDED) c.on(t, (d: unknown) => this.emit('event', { t, d }))
    c.on('fatal', ({ code }: { code: number }) =>
      this.emit('error', new Error(`the gateway closed with ${code}`)),
    )
  }

  private onCryptoEvent<K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]): void {
    if (event === 'linkDone') {
      const { sessionId, ok } = payload as CryptoEvents['linkDone']
      this.linkWaiters.get(sessionId)?.(ok)
    } else if (event === 'status') {
      this.deviceId = (payload as CryptoEvents['status']).deviceId ?? this.deviceId
    } else if (event === 'epochKeysAvailable') {
      const { groupId } = payload as CryptoEvents['epochKeysAvailable']
      const rows = this.pending.get(groupId)
      if (!rows) return
      this.pending.delete(groupId)
      const updates = [...rows.values()].filter(r => r.isUpdate).map(r => r.message)
      const creates = [...rows.values()].filter(r => !r.isUpdate).map(r => r.message)
      void this.ingest(creates, false).then(() => this.ingest(updates, true))
    } else if (event === 'error') {
      const e = payload as CryptoEvents['error']
      this.log(`crypto: ${e.code} ${e.message}`)
    }
  }

  /**
   * Joins the group of each channel that the bot can read, so it gets the keys without sending
   * first (§12.7.8). A join that fails is tried again on the next READY or new channel.
   */
  private joinReadableChannels(): void {
    for (const channel of this.client.cache.channels.values()) {
      if (
        !channel.mlsGroupId &&
        channel.type !== 'text' &&
        channel.type !== 'dm' &&
        channel.type !== 'group_dm'
      )
        continue
      if (channel.type === 'voice' || channel.type === 'category') continue
      if (!this.owns(channel.guildId)) continue
      if (this.joined.has(channel.id)) continue
      this.joined.add(channel.id)
      this.crypto()
        .ensureChannelGroup(channel.id)
        .catch((e: unknown) => {
          this.joined.delete(channel.id)
          this.log(`joining the group of #${channel.name ?? channel.id} failed: ${String(e)}`)
        })
    }
  }

  /** Decrypts server rows in history order and emits the plaintext events. */
  private async ingest(messages: Message[], isUpdate: boolean): Promise<BotMessage[]> {
    if (messages.length === 0) return []
    const sorted = [...messages].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    let results: DecryptResult[]
    try {
      results = await this.crypto().decryptMessages(sorted.map(toEncrypted))
    } catch (e) {
      this.log(`decrypt failed: ${String(e)}`)
      return []
    }
    const out: BotMessage[] = []
    sorted.forEach((m, i) => {
      const r = results[i]
      if (!r) return
      if (r.status === 'pending') {
        let rows = this.pending.get(m.groupId)
        if (!rows) this.pending.set(m.groupId, (rows = new Map()))
        rows.set(m.id, { message: m, isUpdate })
        return
      }
      if (r.status === 'failed') {
        this.log(`message ${m.id} in ${m.channelId} does not decrypt: ${r.reason}`)
        return
      }
      if (r.kind === 'reaction') {
        const target = this.history.idOf(m.channelId, r.content.target)
        if (target)
          this.emit('reaction', {
            channelId: m.channelId,
            guildId: m.guildId,
            messageId: target,
            userId: m.author.id,
            emoji: r.content.emoji,
            remove: r.content.remove,
          })
        return
      }
      if (r.kind !== 'message' && r.kind !== 'edit') return
      const bot: BotMessage = {
        id: m.id,
        channelId: m.channelId,
        guildId: m.guildId,
        author: m.author,
        content: r.content.text,
        mentions: r.content.mentions,
        replyTo: r.content.replyTo ? this.history.idOf(m.channelId, r.content.replyTo) : null,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        clientMsgId: m.clientMsgId,
      }
      const known = this.history.get(m.channelId, m.id)
      this.history.put(bot)
      out.push(bot)
      if (isUpdate || (known && r.kind === 'edit')) this.emit('messageUpdate', bot)
      else {
        if (this.isOwnerLinkCode(bot)) void this.approveByOwner(bot)
        this.emit('message', bot)
      }
    })
    return out
  }

  // MARK: - Calls

  /** Encrypt for the current group of the channel and post; a retry encrypts again (§12.8.6). */
  private async sealAndPost(
    input: EncryptMessageInput,
    post: (envelope: string) => Promise<Message>,
  ): Promise<Message> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.crypto().ensureChannelGroup(input.channelId)
        const sealed = await this.crypto().encryptMessage(input)
        return await post(sealed.envelope)
      } catch (e) {
        if (attempt >= SEND_ATTEMPTS || !retryable(e)) throw e
        await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
      }
    }
  }

  private async decryptOne(m: Message): Promise<BotMessage> {
    const [out] = await this.decryptQuiet([m])
    if (!out) throw new Error(`message ${m.id} did not decrypt`)
    return out
  }

  /** Decrypts without emitting events (own sends and fetched history). */
  private async decryptQuiet(messages: Message[]): Promise<BotMessage[]> {
    const results = await this.crypto().decryptMessages(messages.map(toEncrypted))
    const out: BotMessage[] = []
    messages.forEach((m, i) => {
      const r = results[i]
      if (r?.status !== 'ok' || (r.kind !== 'message' && r.kind !== 'edit')) return
      const bot: BotMessage = {
        id: m.id,
        channelId: m.channelId,
        guildId: m.guildId,
        author: m.author,
        content: r.content.text,
        mentions: r.content.mentions,
        replyTo: r.content.replyTo ? this.history.idOf(m.channelId, r.content.replyTo) : null,
        createdAt: m.createdAt,
        editedAt: m.editedAt,
        clientMsgId: m.clientMsgId,
      }
      this.history.put(bot)
      out.push(bot)
    })
    return out
  }

  /** A message by id, from memory or from the server. */
  async fetchMessage(channelId: string, messageId: string): Promise<BotMessage | null> {
    const known = this.history.get(channelId, messageId)
    if (known) return known
    const page = await this.client.rest.getMessages(channelId, { limit: 100 })
    await this.decryptQuiet(page)
    return this.history.get(channelId, messageId) ?? null
  }

  /** Newest first, as Discord. `before` is a message id. */
  async fetchMessages(
    channelId: string,
    q: { before?: string | undefined; limit?: number | undefined } = {},
  ): Promise<BotMessage[]> {
    const page = await this.client.rest.getMessages(channelId, {
      before: q.before,
      limit: Math.min(q.limit ?? 50, 100),
    })
    const rows = await this.decryptQuiet(
      [...page].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)),
    )
    return rows.reverse()
  }

  async send(
    channelId: string,
    content: { text: string; mentions?: Mention[]; replyTo?: string | null },
  ): Promise<BotMessage> {
    const replyTo = content.replyTo
      ? ((await this.fetchMessage(channelId, content.replyTo))?.clientMsgId ?? null)
      : null
    const nonce = crypto.randomUUID()
    const sent = await this.sealAndPost(
      {
        channelId,
        kind: 'message',
        editOf: null,
        content: {
          text: content.text,
          mentions: content.mentions ?? [],
          attachments: [],
          replyTo,
        },
      },
      envelope => this.client.rest.sendMessage(channelId, { envelope, nonce }),
    )
    return this.decryptOne(sent)
  }

  async edit(
    channelId: string,
    messageId: string,
    content: { text: string; mentions?: Mention[] },
  ): Promise<BotMessage> {
    const original = await this.fetchMessage(channelId, messageId)
    if (!original) throw new RestError(404, 'UnknownMessage', 'Unknown message')
    const replyTo = original.replyTo
      ? (this.history.get(channelId, original.replyTo)?.clientMsgId ?? null)
      : null
    const updated = await this.sealAndPost(
      {
        channelId,
        kind: 'edit',
        editOf: original.clientMsgId,
        content: {
          text: content.text,
          mentions: content.mentions ?? [],
          attachments: [],
          replyTo,
        },
      },
      envelope => this.client.rest.editMessage(channelId, messageId, { envelope }),
    )
    return this.decryptOne(updated)
  }

  async delete(channelId: string, messageId: string): Promise<void> {
    await this.client.rest.deleteMessage(channelId, messageId)
    this.history.drop(channelId, messageId)
  }

  async react(channelId: string, messageId: string, emoji: string, remove = false): Promise<void> {
    const target = await this.fetchMessage(channelId, messageId)
    if (!target) throw new RestError(404, 'UnknownMessage', 'Unknown message')
    const nonce = crypto.randomUUID()
    await this.sealAndPost(
      {
        channelId,
        kind: 'reaction',
        editOf: null,
        content: { target: target.clientMsgId, emoji, remove },
      },
      envelope =>
        this.client.rest.sendMessage(channelId, {
          envelope,
          nonce,
          silent: true,
        }),
    )
  }

  typing(channelId: string): Promise<void> {
    return this.client.rest.triggerTyping(channelId)
  }

  openDm(userId: string): Promise<Channel> {
    return this.client.rest.openDm([userId])
  }

  /** Redeems an invite. Already a member: nothing to do. */
  async joinInvite(code: string): Promise<void> {
    try {
      const guild = await this.client.rest.acceptInvite(code)
      this.log(`joined ${guild.name}`)
    } catch (e) {
      if (e instanceof RestError && (e.code === 'AlreadyMember' || e.status === 409)) return
      this.log(`invite ${code} failed: ${e instanceof RestError ? e.code : String(e)}`)
    }
  }
}
