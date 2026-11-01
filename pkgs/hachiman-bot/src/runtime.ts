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
import { mkdir } from 'node:fs/promises'
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
  type DecryptResult,
  type EncryptMessageInput,
  type Mention,
} from '@hachiman/crypto'
import { E2EE_CAPABILITY } from '@hachiman/crypto/constants'
import { clientPermissions, createEngine } from '@hachiman/crypto/host'
import { createDsTransport } from '@hachiman/hachiman/ds-transport'
import { shardOfGuild } from './ids'
import { DeviceLinker } from './device-link'
import { History } from './history'
import { botApi } from './link'
import { loadDeviceToken, loadWrapKey, lockStateDir, pinOwner } from './state-dir'
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

/** A message that waits after a failed DS call is tried again after this delay. */
const TRANSPORT_RETRY_MS = 3_000

const SEND_ATTEMPTS = 4
const RETRY_BASE_MS = 300

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

export class BotRuntime extends TypedEventEmitter<BotRuntimeEvents> {
  readonly client: HachimanClient
  private api: CryptoApi | null = null
  private deviceId: string | null = null
  private deviceToken: string | null = null
  private ingestQueue: Promise<void> = Promise.resolve()
  /** The identity of this device is ready: gateway events go to the engine. */
  private identityReady = false
  private connected = false
  private gatewayReady: Promise<void> | null = null
  private linker: DeviceLinker | null = null
  private unlock: (() => Promise<void>) | null = null
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
    this.unlock = await lockStateDir(stateDir)
    const wrapKey = await loadWrapKey(stateDir)
    const bot = botApi(this.opts.apiUrl, this.opts.token)
    this.deviceToken = await loadDeviceToken(stateDir, bot)
    const me = await this.client.rest.getMe().catch(async (e: unknown) => {
      // The owner reset the token: the device token went with it. A new one binds this device again.
      if (!(e instanceof RestError && e.status === 401)) throw e
      this.deviceToken = await loadDeviceToken(stateDir, bot, true)
      return this.client.rest.getMe()
    })
    if (!me.bot) this.log(`warning: ${me.username} is not a bot account`)
    const owner = await pinOwner(this.deploymentDir, await bot.owner(), this.log)

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
    this.linker = new DeviceLinker({
      api: this.api,
      userId: me.id,
      stateDir,
      deploymentDir: this.deploymentDir,
      bot,
      owner,
      connect: () => this.connect(),
      reply: (channelId, text) => this.send(channelId, { text }),
      log: this.log,
    })
    this.forwardGatewayEvents()
    status = await this.linker.onboard(status)
    this.deviceId = status.deviceId
    this.identityReady = true

    await this.connect()
    await this.crypto()
      .sync()
      .catch((e: unknown) => this.log(`crypto sync failed: ${String(e)}`))
    this.joinReadableChannels()
    await this.linker.serve()
    await this.acceptChangedKeys()

    for (const code of this.opts.join ?? []) await this.joinInvite(code)
    const user = this.client.cache.user ?? me
    this.emit('ready', user)
    return user
  }

  /**
   * The key changes that came while this bot was not listening (the engine tells a change once,
   * then keeps the contact as 'changed'): accept those of the members that this bot can see.
   */
  // ponytail: one getTrust per known user at start; keep a changed-contacts list in the engine if guilds get huge.
  private async acceptChangedKeys(): Promise<void> {
    const c = this.client.cache
    const users = new Set<string>()
    for (const members of c.members.values()) for (const id of members.keys()) users.add(id)
    for (const ch of c.channels.values()) for (const u of ch.recipients ?? []) users.add(u.id)
    if (c.user) users.delete(c.user.id)
    for (const userId of users) {
      const trust = await this.crypto()
        .getTrust(userId)
        .catch(() => null)
      if (trust?.state === 'changed') await this.onKeyChange({ userId, severity: 'notice' })
    }
  }

  /**
   * A member's master key changed (a password reset, a new identity). The engine refuses that
   * member's devices until someone acknowledges the change (§12.5 TOFU); in the app a person does,
   * and a bot has none. A bot never verifies safety numbers, so its contacts are unverified: it
   * acknowledges the change ('notice') at once, as a person who clicks OK, and syncs so the held
   * commits apply. A 'blocking' change (a contact that this bot verified) is only logged.
   */
  private async onKeyChange({ userId, severity }: CryptoEvents['keyChange']): Promise<void> {
    if (severity === 'blocking')
      return this.log(`the security key of verified contact ${userId} changed: not accepted`)
    try {
      await this.crypto().acknowledgeKeyChange(userId)
      this.log(`accepted the new security key of ${userId}`)
      await this.crypto().sync()
    } catch (e) {
      this.log(`accepting the new security key of ${userId} failed: ${String(e)}`)
    }
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
    this.linker?.stop()
    void this.unlock?.()
    this.unlock = null
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
      this.linker?.onLinkDone(sessionId, ok)
    } else if (event === 'status') {
      this.deviceId = (payload as CryptoEvents['status']).deviceId ?? this.deviceId
    } else if (event === 'epochKeysAvailable') {
      this.retryPending((payload as CryptoEvents['epochKeysAvailable']).groupId)
    } else if (event === 'keyChange') {
      void this.onKeyChange(payload as CryptoEvents['keyChange'])
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
  /**
   * Decrypts server rows and emits the plaintext events. Batches run one at a time, in arrival
   * order, so an edit or a reaction never overtakes the message that it names.
   */
  private ingest(messages: Message[], isUpdate: boolean): Promise<void> {
    const run = this.ingestQueue.then(() => this.ingestNow(messages, isUpdate))
    this.ingestQueue = run.catch(() => undefined)
    return run
  }

  private async ingestNow(messages: Message[], isUpdate: boolean): Promise<void> {
    if (messages.length === 0) return
    const sorted = [...messages].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
    let results: DecryptResult[]
    try {
      results = await this.crypto().decryptMessages(sorted.map(toEncrypted))
    } catch (e) {
      this.log(`decrypt failed: ${String(e)}`)
      return
    }
    // Fail closed: a result names its row by id (§12.8.5).
    const byId = new Map(results.map(r => [r.messageId, r]))
    for (const m of sorted) {
      const r = byId.get(m.id)
      if (!r) continue
      if (r.status === 'pending') {
        let rows = this.pending.get(m.groupId)
        if (!rows) this.pending.set(m.groupId, (rows = new Map()))
        rows.set(m.id, { message: m, isUpdate })
        // A failed DS call is not a verdict: try again soon. The other reasons wait for keys.
        if (r.reason === 'transport') setTimeout(() => this.retryPending(m.groupId), TRANSPORT_RETRY_MS)
        continue
      }
      if (r.status === 'failed') {
        this.log(`message ${m.id} in ${m.channelId} does not decrypt: ${r.reason}`)
        continue
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
        continue
      }
      if (r.kind !== 'message' && r.kind !== 'edit') continue
      const known = this.history.get(m.channelId, m.id)
      const bot = this.remember(m, r.content)
      // A link code from the owner holds a link secret: the device links, and the bot code never sees it.
      if (this.linker?.takeOwnerLinkCode(bot)) continue
      if (isUpdate || (known && r.kind === 'edit')) this.emit('messageUpdate', bot)
      else this.emit('message', bot)
    }
  }

  /** Decrypts the waiting rows of a group again (new epoch keys, or after a failed DS call). */
  private retryPending(groupId: string): void {
    const rows = this.pending.get(groupId)
    if (!rows) return
    this.pending.delete(groupId)
    const all = [...rows.values()]
    void this.ingest(
      all.filter(r => !r.isUpdate).map(r => r.message),
      false,
    ).then(() =>
      this.ingest(
        all.filter(r => r.isUpdate).map(r => r.message),
        true,
      ),
    )
  }

  /** A decrypted chat row, kept for edits, replies and reactions. */
  private remember(
    m: Message,
    content: { text: string; mentions: Mention[]; replyTo: string | null },
  ): BotMessage {
    const bot: BotMessage = {
      id: m.id,
      channelId: m.channelId,
      guildId: m.guildId,
      author: m.author,
      content: content.text,
      mentions: content.mentions,
      replyTo: content.replyTo ? this.history.idOf(m.channelId, content.replyTo) : null,
      createdAt: m.createdAt,
      editedAt: m.editedAt,
      clientMsgId: m.clientMsgId,
    }
    this.history.put(bot)
    return bot
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
    const results = new Map(
      (await this.crypto().decryptMessages(messages.map(toEncrypted))).map(r => [r.messageId, r]),
    )
    const out: BotMessage[] = []
    for (const m of messages) {
      const r = results.get(m.id)
      if (r?.status === 'ok' && (r.kind === 'message' || r.kind === 'edit'))
        out.push(this.remember(m, r.content))
    }
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
