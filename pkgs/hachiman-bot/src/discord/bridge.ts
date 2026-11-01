/**
 * A Discord API v10 server on localhost over a Hachiman bot runtime (docs/bots-plan.md §3, §6).
 * A Discord library talks to it as it talks to discord.com: REST under `/api[/v10]`, the gateway
 * at `/gateway`. Content is plaintext here: the bridge runs next to the bot, in the process or on
 * the machine of the bot operator, and only the runtime talks to Hachiman (ciphertext).
 *
 * Auth: `Authorization: Bot <token>` and IDENTIFY must carry the bot's Hachiman token. The bridge
 * listens on 127.0.0.1 by default.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { RestError, type HachimanCache, type User } from '@hachiman/client'
import { WebSocketServer, type WebSocket } from 'ws'
import { inShards, type IdMap } from '../ids'
import { bareToken } from '../link'
import type { BotRuntime, BotRuntimeEvents } from '../runtime'
import { guildForIntents, wireDispatches, type Emit } from './events'
import * as shape from './shapes'

export { Intents } from './events'

/** What the bridge needs from the runtime. Tests give a fake. */
export interface BridgeRuntime extends Pick<
  BotRuntime,
  'send' | 'edit' | 'delete' | 'react' | 'fetchMessages' | 'fetchMessage' | 'typing' | 'openDm'
> {
  readonly cache: HachimanCache
  readonly user: User | null
  on<K extends keyof BotRuntimeEvents>(event: K, listener: BotRuntimeEvents[K]): unknown
}

export interface BridgeOptions {
  runtime: BridgeRuntime
  ids: IdMap
  /** The token that Discord clients must present (the bot's Hachiman token). */
  token: string
  port?: number
  host?: string
  log?: (msg: string) => void
}

const HEARTBEAT_MS = 41250
/** Events kept per session for RESUME. */
const RESUME_BUFFER = 1000
/** A closed session can be resumed this long; then it is gone. */
const RESUME_WINDOW_MS = 60_000

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

interface Session {
  id: string
  ws: WebSocket | null
  intents: number
  seq: number
  buffer: { s: number; frame: string }[]
  /** IDENTIFY `shard: [id, count]`: the session gets the guilds of that shard, and DMs on shard 0. */
  shard: [number, number] | null
  /** Set while the socket is closed: the session ends unless it resumes first. */
  expiry: ReturnType<typeof setTimeout> | null
}

type Json = Record<string, unknown>

export class DiscordBridge {
  private server: Server
  private wss: WebSocketServer
  private sessions = new Map<string, Session>()
  private readonly log: (msg: string) => void
  private warned = new Set<string>()
  private port = 0

  constructor(private readonly opts: BridgeOptions) {
    this.log = opts.log ?? (m => console.log(`[hachiman-bridge] ${m}`))
    this.server = createServer((req, res) => void this.onRest(req, res))
    this.wss = new WebSocketServer({ noServer: true })
    this.server.on('upgrade', (req, socket, head) => {
      if (!(req.url ?? '').startsWith('/gateway')) {
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, ws => this.onSocket(ws))
    })
    wireDispatches(opts.runtime, () => this.ctx, (t, d, intent) => this.broadcast(t, d, intent))
  }

  private get ctx(): shape.ShapeContext {
    return { ids: this.opts.ids, cache: this.opts.runtime.cache }
  }

  /** Listens; resolves the base URLs that a Discord client uses. */
  listen(): Promise<{ api: string; gateway: string; port: number }> {
    const host = this.opts.host ?? '127.0.0.1'
    return new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.opts.port ?? 0, host, () => {
        const addr = this.server.address()
        this.port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({
          api: `http://${host}:${this.port}/api`,
          gateway: `ws://${host}:${this.port}/gateway`,
          port: this.port,
        })
      })
    })
  }

  close(): Promise<void> {
    for (const s of this.sessions.values()) if (s.expiry) clearTimeout(s.expiry)
    this.sessions.clear()
    for (const ws of this.wss.clients) ws.close(1001)
    return new Promise(resolve => this.server.close(() => resolve()))
  }

  private gatewayUrl(): string {
    return `ws://${this.opts.host ?? '127.0.0.1'}:${this.port}/gateway`
  }

  private warnOnce(what: string): void {
    if (this.warned.has(what)) return
    this.warned.add(what)
    this.log(`not supported on Hachiman yet: ${what}`)
  }

  /** Gives every cached entity its snowflake, so that the ids of an earlier run resolve. */
  private indexCache(): void {
    const { ids, runtime } = this.opts
    const c = runtime.cache
    if (c.user) ids.snowflake(c.user.id)
    for (const g of c.guilds.values()) ids.snowflake(g.id, g.createdAt)
    for (const roles of c.roles.values()) for (const r of roles.values()) ids.snowflake(r.id)
    for (const ch of c.channels.values()) {
      ids.snowflake(ch.id)
      for (const u of ch.recipients ?? []) ids.snowflake(u.id)
    }
    for (const members of c.members.values()) for (const m of members.values()) ids.snowflake(m.user.id)
  }

  private uuid(snow: string | undefined, what: string): string {
    if (!snow) throw new HttpError(404, 10003, `Unknown ${what}`)
    let id = this.opts.ids.uuid(snow)
    if (!id) {
      this.indexCache()
      id = this.opts.ids.uuid(snow)
    }
    if (!id) throw new HttpError(404, 10003, `Unknown ${what}`)
    return id
  }

  /** A message id, also one from an earlier run: its snowflake is found in the channel's recent history. */
  private async messageUuid(channelId: string, snow: string | undefined): Promise<string> {
    const known = snow ? this.opts.ids.uuid(snow) : null
    if (known) return known
    if (snow)
      for (const m of await this.opts.runtime.fetchMessages(channelId, { limit: 100 }))
        this.opts.ids.snowflake(m.id, m.createdAt)
    const id = snow ? this.opts.ids.uuid(snow) : null
    if (!id) throw new HttpError(404, 10008, 'Unknown Message')
    return id
  }

  // MARK: - REST

  private async onRest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown): void => {
      res.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    try {
      const url = new URL(req.url ?? '/', 'http://bridge')
      const path = url.pathname.replace(/^\/api(\/v\d+)?/, '')
      const auth = req.headers.authorization ?? ''
      if (!path.startsWith('/gateway') || path === '/gateway/bot') {
        if (bareToken(auth) !== this.opts.token)
          throw new HttpError(401, 0, '401: Unauthorized')
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readJson(req)
      const out = await this.route(req.method ?? 'GET', path, url.searchParams, body)
      if (out === undefined) send(204)
      else send(200, out)
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { code: e.code, message: e.message })
      if (e instanceof RestError) {
        const code = e.status === 404 ? 10008 : e.status === 403 ? 50013 : 0
        return send(e.status >= 400 && e.status < 600 ? e.status : 500, {
          code,
          message: `${e.code}: ${e.message}`,
        })
      }
      this.log(`REST ${req.method} ${req.url} failed: ${String(e)}`)
      send(500, { code: 0, message: String(e) })
    }
  }

  private async route(method: string, path: string, q: URLSearchParams, body: Json): Promise<unknown> {
    const rt = this.opts.runtime
    const ctx = this.ctx
    const me = rt.user
    const seg = path.split('/').filter(Boolean)
    const is = (m: string, ...parts: string[]): boolean =>
      method === m && seg.length === parts.length && parts.every((p, i) => p === '*' || p === seg[i])

    if (is('GET', 'gateway')) return { url: this.gatewayUrl() }
    if (is('GET', 'gateway', 'bot'))
      return {
        url: this.gatewayUrl(),
        shards: 1,
        session_start_limit: {
          total: 1000,
          remaining: 1000,
          reset_after: 0,
          max_concurrency: 1,
        },
      }
    if (!me) throw new HttpError(503, 0, 'The bot is not connected yet')
    const meSnow = ctx.ids.snowflake(me.id)

    if (is('GET', 'users', '@me'))
      return {
        ...shape.user(ctx, me),
        bot: true,
        verified: true,
        mfa_enabled: false,
      }
    if (is('GET', 'users', '*')) {
      const id = this.uuid(seg[1], 'user')
      const u = findUser(rt.cache, id)
      if (!u) throw new HttpError(404, 10013, 'Unknown User')
      return shape.user(ctx, u)
    }
    if (is('GET', 'applications', '@me') || is('GET', 'oauth2', 'applications', '@me'))
      return application(meSnow, me.username)
    if (seg[0] === 'applications' && seg[2] === 'commands') {
      // Slash commands: Hachiman has no interactions yet. Registration succeeds and does nothing.
      this.warnOnce('slash commands (application commands)')
      if (method === 'PUT')
        return Array.isArray(body)
          ? body.map((c, i) => ({
              ...c,
              id: String(BigInt(meSnow) + BigInt(i + 1)),
              application_id: meSnow,
              version: '1',
            }))
          : []
      if (method === 'POST')
        return {
          ...body,
          id: String(BigInt(meSnow) + 1n),
          application_id: meSnow,
          version: '1',
        }
      if (method === 'DELETE') return undefined
      return []
    }
    if (is('GET', 'users', '@me', 'guilds'))
      return [...rt.cache.guilds.values()].map(g => ({
        id: ctx.ids.snowflake(g.id, g.createdAt),
        name: g.name,
        icon: null,
        owner: g.ownerId === me.id,
        permissions: '0',
        features: [],
      }))
    if (is('POST', 'users', '@me', 'channels')) {
      const recipient = this.uuid(String(body['recipient_id'] ?? ''), 'user')
      const dm = await rt.openDm(recipient)
      return shape.channel(ctx, dm)
    }

    if (seg[0] === 'guilds' && seg[1]) {
      const guildId = this.uuid(seg[1], 'guild')
      if (is('GET', 'guilds', '*')) {
        const g = shape.guildFull(ctx, guildId, me.id)
        if (!g) throw new HttpError(404, 10004, 'Unknown Guild')
        return {
          ...g,
          approximate_member_count: g['member_count'],
          approximate_presence_count: 0,
        }
      }
      if (is('GET', 'guilds', '*', 'channels'))
        return [...rt.cache.channels.values()]
          .filter(c => c.guildId === guildId)
          .flatMap(c => shape.channel(ctx, c) ?? [])
      if (is('GET', 'guilds', '*', 'roles'))
        return [...(rt.cache.roles.get(guildId)?.values() ?? [])].map(r => shape.role(ctx, r))
      if (is('GET', 'guilds', '*', 'members')) {
        const limit = Math.min(Number(q.get('limit') ?? 1), 1000)
        return [...(rt.cache.members.get(guildId)?.values() ?? [])]
          .slice(0, limit)
          .map(m => shape.member(ctx, m))
      }
      if (is('GET', 'guilds', '*', 'members', '*')) {
        const m = rt.cache.members.get(guildId)?.get(seg[3] === '@me' ? me.id : this.uuid(seg[3], 'member'))
        if (!m) throw new HttpError(404, 10007, 'Unknown Member')
        return shape.member(ctx, m)
      }
    }

    if (seg[0] === 'channels' && seg[1]) {
      const channelId = this.uuid(seg[1], 'channel')
      if (is('GET', 'channels', '*')) {
        const c = rt.cache.channels.get(channelId)
        const out = c ? shape.channel(ctx, c) : null
        if (!out) throw new HttpError(404, 10003, 'Unknown Channel')
        return out
      }
      if (is('POST', 'channels', '*', 'typing')) return void (await rt.typing(channelId))
      if (is('GET', 'channels', '*', 'messages')) {
        const before = q.get('before') ? await this.messageUuid(channelId, q.get('before') ?? '') : undefined
        const rows = await rt.fetchMessages(channelId, {
          before,
          limit: Number(q.get('limit') ?? 50),
        })
        return rows.map(m => shape.message(ctx, m))
      }
      if (is('POST', 'channels', '*', 'messages')) {
        const { text, mentions } = this.outgoing(body)
        const ref = (body['message_reference'] as { message_id?: string } | undefined)?.message_id
        const sent = await rt.send(channelId, {
          text,
          mentions,
          replyTo: ref ? await this.messageUuid(channelId, ref) : null,
        })
        return shape.message(ctx, sent, { nonce: body['nonce'] })
      }
      if (seg[2] === 'messages' && seg[3]) {
        const messageId = await this.messageUuid(channelId, seg[3])
        if (is('GET', 'channels', '*', 'messages', '*')) {
          const m = await rt.fetchMessage(channelId, messageId)
          if (!m) throw new HttpError(404, 10008, 'Unknown Message')
          return shape.message(ctx, m)
        }
        if (is('PATCH', 'channels', '*', 'messages', '*')) {
          const { text, mentions } = this.outgoing(body)
          return shape.message(ctx, await rt.edit(channelId, messageId, { text, mentions }))
        }
        if (is('DELETE', 'channels', '*', 'messages', '*'))
          return void (await rt.delete(channelId, messageId))
        if (seg[4] === 'reactions' && seg[5] && seg[6] === '@me' && seg.length === 7) {
          const emoji = decodeURIComponent(seg[5])
          if (method === 'PUT') return void (await rt.react(channelId, messageId, emoji))
          if (method === 'DELETE') return void (await rt.react(channelId, messageId, emoji, true))
        }
      }
    }

    this.warnOnce(`${method} ${path.replace(/\d{6,}/g, ':id')}`)
    throw new HttpError(404, 0, '404: Not Found')
  }

  /** A Discord message body → Hachiman text: content, then the embeds as markdown. */
  private outgoing(body: Json): {
    text: string
    mentions: ReturnType<typeof shape.textFromDiscord>['mentions']
  } {
    if (Array.isArray(body['attachments']) && body['attachments'].length > 0)
      this.warnOnce('file attachments')
    if (Array.isArray(body['components']) && body['components'].length > 0)
      this.warnOnce('message components (buttons, menus)')
    const content = typeof body['content'] === 'string' ? body['content'] : ''
    const embeds = shape.embedsToText(body['embeds'])
    const { text, mentions } = shape.textFromDiscord(this.ctx, [content, embeds].filter(Boolean).join('\n\n'))
    if (!text.trim()) throw new HttpError(400, 50006, 'Cannot send an empty message')
    return { text, mentions }
  }

  // MARK: - Gateway

  private onSocket(ws: WebSocket): void {
    let session: Session | null = null
    const send = (frame: Json): void => ws.send(JSON.stringify(frame))
    send({ op: 10, d: { heartbeat_interval: HEARTBEAT_MS }, s: null, t: null })
    const timeout = setTimeout(() => ws.close(4003, 'Not authenticated'), 30_000)

    ws.on('message', raw => {
      let frame: { op?: number; d?: Json | number | null }
      try {
        frame = JSON.parse(String(raw)) as typeof frame
      } catch {
        return ws.close(4002, 'Decode error')
      }
      const d = (frame.d ?? {}) as Json
      switch (frame.op) {
        case 1:
          return send({ op: 11, d: null, s: null, t: null })
        case 2: {
          if (bareToken(String(d['token'] ?? '')) !== this.opts.token)
            return ws.close(4004, 'Authentication failed')
          clearTimeout(timeout)
          session = {
            id: crypto.randomUUID().replace(/-/g, ''),
            ws,
            intents: Number(d['intents'] ?? 0),
            seq: 0,
            buffer: [],
            shard: parseShard(d['shard']),
            expiry: null,
          }
          this.sessions.set(session.id, session)
          return this.ready(session)
        }
        case 6: {
          const old = this.sessions.get(String(d['session_id'] ?? ''))
          const after = Number(d['seq'] ?? 0)
          // The events after `after` must all be in the buffer, else the client would miss some.
          const oldest = old?.buffer[0]?.s ?? (old?.seq ?? 0) + 1
          if (!old || bareToken(String(d['token'] ?? '')) !== this.opts.token || after < oldest - 1) {
            if (old) this.endSession(old)
            return send({ op: 9, d: false, s: null, t: null })
          }
          clearTimeout(timeout)
          if (old.expiry) clearTimeout(old.expiry)
          old.expiry = null
          old.ws?.close(4000)
          old.ws = ws
          session = old
          for (const b of old.buffer) if (b.s > after) ws.send(b.frame)
          return this.dispatch(old, 'RESUMED', {})
        }
        case 8:
          if (session) this.memberChunks(session, d)
          return
        default:
          return // op 3 presence, op 4 voice: nothing to do on Hachiman
      }
    })
    ws.on('close', () => {
      clearTimeout(timeout)
      if (session?.ws !== ws) return
      const closed = session
      closed.ws = null
      closed.expiry = setTimeout(() => this.endSession(closed), RESUME_WINDOW_MS)
      closed.expiry.unref()
    })
  }

  private endSession(s: Session): void {
    if (s.expiry) clearTimeout(s.expiry)
    s.ws?.close(4000)
    this.sessions.delete(s.id)
  }

  private dispatch(session: Session, t: string, d: unknown): void {
    session.seq += 1
    const frame = JSON.stringify({ op: 0, t, s: session.seq, d })
    session.buffer.push({ s: session.seq, frame })
    if (session.buffer.length > RESUME_BUFFER) session.buffer.shift()
    if (session.ws?.readyState === 1) session.ws.send(frame)
  }

  private ready(session: Session): void {
    const rt = this.opts.runtime
    const me = rt.user
    if (!me) return session.ws?.close(4000, 'The bot is not connected to Hachiman yet')
    const ctx = this.ctx
    const meSnow = ctx.ids.snowflake(me.id)
    // The guild snowflakes carry their creation time; give them out before anything else names them.
    for (const g of rt.cache.guilds.values()) ctx.ids.snowflake(g.id, g.createdAt)
    const guilds = [...rt.cache.guilds.keys()].filter(id => this.inShard(session, rt.cache.guilds.get(id)))
    this.dispatch(session, 'READY', {
      v: 10,
      user: {
        ...shape.user(ctx, me),
        bot: true,
        verified: true,
        mfa_enabled: false,
      },
      guilds: guilds.map(id => ({
        id: ctx.ids.snowflake(id),
        unavailable: true,
      })),
      session_id: session.id,
      resume_gateway_url: this.gatewayUrl(),
      session_type: 'normal',
      application: { id: meSnow, flags: 0 },
      private_channels: [],
      relationships: [],
      presences: [],
    })
    for (const id of guilds) {
      const g = shape.guildFull(ctx, id, me.id)
      if (g) this.dispatch(session, 'GUILD_CREATE', guildForIntents(g, session.intents, meSnow))
    }
  }

  private memberChunks(session: Session, d: Json): void {
    const guildIds = Array.isArray(d['guild_id'])
      ? (d['guild_id'] as string[])
      : [String(d['guild_id'] ?? '')]
    for (const snow of guildIds) {
      const guildId = this.opts.ids.uuid(snow)
      if (!guildId) continue
      const members = [...(this.opts.runtime.cache.members.get(guildId)?.values() ?? [])]
      this.dispatch(session, 'GUILD_MEMBERS_CHUNK', {
        guild_id: snow,
        members: members.map(m => shape.member(this.ctx, m)),
        chunk_index: 0,
        chunk_count: 1,
        not_found: [],
        ...(d['nonce'] !== undefined ? { nonce: d['nonce'] } : {}),
      })
    }
  }

  /** The session's share of the shard rule (inShards); without IDENTIFY `shard` it gets all. */
  private inShard(s: Session, scope: Parameters<typeof inShards>[2]): boolean {
    return !s.shard || inShards([s.shard[0]], s.shard[1], scope)
  }

  /** Sends `t` to every session whose intents and shard ask for it. */
  private broadcast(...[t, d, intent]: Parameters<Emit>): void {
    for (const s of this.sessions.values()) {
      if (intent !== null && !(s.intents & intent)) continue
      const payload = typeof d === 'function' ? d(s.intents) : d
      const snow =
        payload['guild_id'] ??
        (t === 'GUILD_CREATE' || t === 'GUILD_UPDATE' || t === 'GUILD_DELETE' ? payload['id'] : null)
      const guildId = typeof snow === 'string' ? this.opts.ids.uuid(snow) : null
      const scope =
        t === 'USER_UPDATE'
          ? undefined
          : typeof snow !== 'string'
            ? 'dm'
            : guildId
              ? this.opts.runtime.cache.guilds.get(guildId)
              : undefined
      if (this.inShard(s, scope)) this.dispatch(s, t, payload)
    }
  }
}

function parseShard(v: unknown): [number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null
  const [id, count] = v.map(Number)
  return Number.isInteger(id) && Number.isInteger(count) && count! > 0 && id! >= 0 && id! < count!
    ? [id!, count!]
    : null
}

function application(id: string, name: string): Json {
  return {
    id,
    name,
    icon: null,
    description: '',
    bot_public: false,
    bot_require_code_grant: false,
    verify_key: '',
    flags: 0,
    team: null,
    owner: { id, username: name, discriminator: '0', avatar: null, flags: 0 },
  }
}

function findUser(cache: HachimanCache, id: string): User | null {
  if (cache.user?.id === id) return cache.user
  for (const members of cache.members.values()) {
    const m = members.get(id)
    if (m) return m.user
  }
  for (const c of cache.channels.values()) {
    const u = c.recipients?.find(r => r.id === id)
    if (u) return u
  }
  return null
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const type = req.headers['content-type'] ?? ''
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  if (type.startsWith('multipart/form-data')) {
    // discord.js sends a message with files as multipart; the JSON part is `payload_json`.
    const match = /name="payload_json"\r\n(?:Content-Type: [^\r\n]+\r\n)?\r\n([\s\S]*?)\r\n--/i.exec(raw)
    const payload = match?.[1] ? (JSON.parse(match[1]) as Json) : {}
    return { ...payload, attachments: [{ id: '0' }] }
  }
  try {
    return JSON.parse(raw) as Json
  } catch {
    throw new HttpError(400, 50109, 'The request body contains invalid JSON.')
  }
}
