/**
 * One headless Hachiman client for the canary (src/e2ee/canary.integration.ts): the real
 * @hachiman/client HachimanClient (REST + gateway WebSocket) and the real @hachiman/crypto engine
 * over the UI's main-thread DsTransport, in this Node process. The engine runs in-process instead
 * of in a Worker; its IndexedDB store is fake-indexeddb.
 */
import { HachimanClient, type Message } from '@hachiman/client'
import type { CryptoEvents, CryptoGatewayEvent, CryptoStatus, DecryptResult, DsTransport, EncryptedMessage } from '@hachiman/crypto'

import { createDsTransport } from '../../../hachiman/src/services/ds-transport'
import { createEngine, type Engine } from '../../../../pkgs/hachiman-crypto/src/worker/engine'
import { clientPermissions } from '../../../../pkgs/hachiman-crypto/src/worker/permissions'

export const CLIENT_VERSION = '1.0.0'

const CRYPTO_EVENTS = [
  'MLS_HANDSHAKE',
  'MLS_BATCH_ASSIGN',
  'MLS_JOIN_UPDATE',
  'MLS_GROUP_UPDATE',
  'DEVICE_INBOX',
  'DEVICE_LINK',
  'USER_KEYS_UPDATE',
  'KEY_PACKAGES_LOW',
  'KT_TREE_HEAD',
] as const satisfies readonly CryptoGatewayEvent['t'][]

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Polls `fn` until it returns a value that is not undefined. */
export async function waitFor<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < end) {
    try {
      const v = await fn()
      if (v !== undefined) return v
    } catch (e) {
      last = e
    }
    await sleep(250)
  }
  throw new Error(`canary: timed out waiting for ${what}${last ? ` (last error: ${String(last)})` : ''}`)
}

export function toEncrypted(m: Message): EncryptedMessage {
  return {
    id: m.id,
    channelId: m.channelId,
    guildId: m.guildId,
    authorId: m.author.id,
    senderDevice: m.senderDevice,
    groupId: m.groupId,
    epoch: m.epoch,
    clientMsgId: m.clientMsgId,
    envelope: m.envelope,
    attachments: m.attachments.map((a) => ({ id: a.id, size: a.size })),
    createdAt: m.createdAt,
    editedAt: m.editedAt,
  }
}

export interface ClientOptions {
  name: string
  userId: string
  accessToken: string
  /** Takusen origin, for example http://localhost:3100. */
  base: string
  gatewayUrl: string
  log: (line: string) => void
}

export class CanaryClient {
  readonly hachiman: HachimanClient
  readonly engine: Engine
  deviceId: string | null = null
  readonly errors: CryptoEvents['error'][] = []
  /** MESSAGE_CREATE payloads, by message id. */
  readonly received = new Map<string, Message>()
  private ready = false

  constructor(readonly opts: ClientOptions) {
    this.hachiman = new HachimanClient({
      apiUrl: `${opts.base}/api/v1`,
      gatewayUrl: opts.gatewayUrl,
      getToken: () => Promise.resolve(opts.accessToken),
      device: () => (this.deviceId ? { deviceId: this.deviceId, capabilities: ['e2ee/1'], clientVersion: CLIENT_VERSION } : null),
      // The engine signs the device proofs (§12.12, §12.13), as the Worker does in the app.
      proveDevice: (req) => this.engine.api.proveDevice(req),
      voiceE2ee: () => {
        throw new Error('canary: no voice')
      },
    })
    const base = createDsTransport(this.hachiman.rest, this.hachiman.cache)
    // The device id goes into X-Hachiman-Device and IDENTIFY as soon as the device row exists.
    const transport: DsTransport = {
      ...base,
      registerDevice: async (body) => {
        const device = await base.registerDevice(body)
        this.deviceId = device.id
        return device
      },
    }
    this.engine = createEngine({
      transport,
      adminPermissions: clientPermissions,
      emit: (event, payload) => {
        if (event === 'error') {
          this.errors.push(payload as CryptoEvents['error'])
          opts.log(`${opts.name} crypto error ${JSON.stringify(payload)}`)
        }
      },
    })
    for (const t of CRYPTO_EVENTS) {
      this.hachiman.on(t, (d: unknown) => {
        if (!this.ready) return
        void this.engine.api.onGatewayEvent({ t, d } as CryptoGatewayEvent).catch((e: unknown) => opts.log(`${opts.name} ${t} failed: ${String(e)}`))
      })
    }
    this.hachiman.on('ready', () => {
      if (this.ready) void this.engine.api.sync().catch((e: unknown) => opts.log(`${opts.name} sync failed: ${String(e)}`))
    })
    this.hachiman.on('MESSAGE_CREATE', (m) => this.received.set(m.id, m))
    this.hachiman.on('fatal', (e) => opts.log(`${opts.name} gateway fatal ${e.code}`))
  }

  /** First device of a new account: identity, device certificate, key packages, then the gateway. */
  async start(): Promise<CryptoStatus> {
    const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const first = await this.engine.api.init({
      userId: this.opts.userId,
      wrapKey,
      platform: 'browser',
      clientVersion: CLIENT_VERSION,
      deviceName: `canary ${this.opts.name}`,
      origin: this.opts.base,
    })
    if (first.state !== 'needs_identity') throw new Error(`canary: ${this.opts.name} starts in state ${first.state}`)
    const { status } = await this.engine.api.setupFirstDevice()
    if (status.state !== 'ready') throw new Error(`canary: ${this.opts.name} setup ended in ${status.state}`)
    this.ready = true
    const readyEvent = new Promise<void>((resolve) => this.hachiman.once('ready', () => resolve()))
    this.hachiman.connect()
    await readyEvent
    await this.engine.api.sync()
    return status
  }

  /** Encrypt for the channel's current group and post, as MessagesService.send does (with its retries). */
  async send(channelId: string, text: string, attachments: Parameters<CanaryClient['engine']['api']['encryptMessage']>[0]['content']['attachments'] = []): Promise<Message> {
    const ids = attachments.flatMap((p) => (p.thumbnail ? [p.uploadId, p.thumbnail.uploadId] : [p.uploadId]))
    for (let attempt = 1; ; attempt++) {
      try {
        await this.engine.api.ensureChannelGroup(channelId)
        const sealed = await this.engine.api.encryptMessage({ channelId, kind: 'message', editOf: null, content: { text, mentions: [], attachments, replyTo: null } })
        return await this.hachiman.rest.sendMessage(channelId, { envelope: sealed.envelope, nonce: crypto.randomUUID(), attachments: ids.length > 0 ? ids : undefined })
      } catch (e) {
        const code = (e as { dsCode?: string; code?: string }).dsCode ?? (e as { code?: string }).code
        if (attempt >= 8 || !['StaleEpoch', 'GroupPending', 'EpochConflict', 'PendingRemoves', 'Transport'].includes(String(code))) throw e
        this.opts.log(`${this.opts.name} send retry ${attempt} after ${String(code)}: ${(e as Error).message}`)
        await sleep(500 * attempt)
      }
    }
  }

  /** Decrypts a message until it is 'ok' or a final failure. Pending results wait for keys. */
  async decrypt(m: Message, timeoutMs = 60_000): Promise<Extract<DecryptResult, { status: 'ok' }>> {
    const end = Date.now() + timeoutMs
    let last: DecryptResult | null = null
    while (Date.now() < end) {
      const [r] = await this.engine.api.decryptMessages([toEncrypted(m)])
      last = r!
      if (r!.status === 'ok') return r!
      if (r!.status === 'failed') throw new Error(`canary: ${this.opts.name} cannot decrypt ${m.id}: ${JSON.stringify(r)}`)
      await sleep(500)
    }
    throw new Error(`canary: ${this.opts.name} still cannot decrypt ${m.id}: ${JSON.stringify(last)}`)
  }

  async stop(): Promise<void> {
    this.hachiman.disconnect()
    await this.engine.idle().catch(() => undefined)
  }
}
