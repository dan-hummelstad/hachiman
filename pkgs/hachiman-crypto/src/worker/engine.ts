/**
 * The crypto engine inside the Worker (docs/gateway-protocol.md §12.17): one CryptoApi composed
 * of the identity, group, message, voice and admin services over one EngineContext.
 *
 * - init() opens the store and builds the services. Calls before init give NotInitialized.
 * - Gateway events: DEVICE_INBOX and MLS_* go to GroupService. USER_KEYS_UPDATE, KT_TREE_HEAD,
 *   KEY_PACKAGES_LOW and DEVICE_LINK go to IdentityService.
 * - Calls per group run one at a time, in arrival order: MLS_* events by group id, DEVICE_INBOX
 *   in one queue, and ensureChannelGroup / encryptMessage by channel. The services also lock
 *   their own state per group.
 */
import {
  CryptoError,
  type AdminPermissionModel,
  type AdminService,
  type CryptoApi,
  type CryptoEvents,
  type CryptoGatewayEvent,
  type CryptoStatus,
  type CryptoStore,
  type DsTransport,
  type EngineContext,
  type IdentityService,
  type InitOptions,
  type MessageService,
  type VoiceService,
} from '../api'
import { createAdminService } from '../admin/service'
import { createMessageService } from '../envelope/service'
import { createIdentityService } from '../identity/service'
import { createVoiceService } from '../media/service'
import { mls } from '../mls/index'
import { createGroupService, type GroupServiceExt } from '../mls/service'
import { createCryptoStore } from '../store/index'

export interface EngineEnv {
  transport: DsTransport
  emit<K extends keyof CryptoEvents>(event: K, payload: CryptoEvents[K]): void
  /** The §2 rules (worker/permissions.ts in production). */
  adminPermissions: AdminPermissionModel
  /** Default: the IndexedDB store. */
  store?: CryptoStore
  now?: () => number
  random?: (n: number) => Uint8Array
}

export interface Engine {
  api: CryptoApi
  /** Resolves when the background work of the group service is done (tests). */
  idle(): Promise<void>
}

interface Services {
  key: string
  init: InitOptions
  identity: IdentityService
  groups: GroupServiceExt
  messages: MessageService
  voice: VoiceService
  admin: AdminService
}

const GROUP_EVENTS = new Set<CryptoGatewayEvent['t']>(['MLS_HANDSHAKE', 'MLS_BATCH_ASSIGN', 'MLS_JOIN_UPDATE', 'MLS_GROUP_UPDATE', 'DEVICE_INBOX'])
const IDENTITY_EVENTS = new Set<CryptoGatewayEvent['t']>(['USER_KEYS_UPDATE', 'KT_TREE_HEAD', 'KEY_PACKAGES_LOW', 'DEVICE_LINK'])

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  // getRandomValues takes at most 65536 bytes per call.
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)))
  return out
}

function checkEvent(e: unknown): CryptoGatewayEvent {
  if (typeof e !== 'object' || e === null) throw new CryptoError('Malformed', 'gateway event is not an object')
  const o = e as { t?: unknown; d?: unknown }
  if (typeof o.t !== 'string' || typeof o.d !== 'object' || o.d === null) throw new CryptoError('Malformed', 'gateway event needs t and d')
  return e as CryptoGatewayEvent
}

export function createEngine(env: EngineEnv): Engine {
  const store = env.store ?? createCryptoStore()
  const now = env.now ?? Date.now
  const random = env.random ?? randomBytes
  let services: Services | null = null
  let initializing: Promise<CryptoStatus> | null = null
  const queues = new Map<string, Promise<unknown>>()

  /** Runs `fn` after every earlier call with the same key. */
  function serial<R>(key: string, fn: () => Promise<R>): Promise<R> {
    const prev = queues.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return run
  }

  function s(): Services {
    if (services === null) throw new CryptoError('NotInitialized', 'call init first')
    return services
  }

  async function build(opts: InitOptions): Promise<CryptoStatus> {
    await store.open({ origin: opts.origin, userId: opts.userId, wrapKey: opts.wrapKey })
    const ctx: EngineContext = {
      store,
      transport: env.transport,
      emit: (event, payload) => {
        env.emit(event, payload)
      },
      now,
      random,
      origin: opts.origin,
      platform: opts.platform,
      clientVersion: opts.clientVersion,
    }
    const identity = createIdentityService(ctx, { mls, adminPermissions: env.adminPermissions })
    const groups = createGroupService(ctx, identity, { adminPermissions: env.adminPermissions })
    const next: Services = {
      key: `${opts.origin}\n${opts.userId}`,
      init: opts,
      identity,
      groups,
      messages: createMessageService(ctx, identity, groups),
      voice: createVoiceService(ctx, identity),
      admin: createAdminService(ctx, identity),
    }
    await identity.load(opts)
    services = next
    return identity.status()
  }

  async function init(opts: InitOptions): Promise<CryptoStatus> {
    if (typeof opts !== 'object' || typeof opts.userId !== 'string' || typeof opts.origin !== 'string') throw new CryptoError('Malformed', 'init options')
    if (initializing !== null) await initializing.catch(() => undefined)
    const cur = services
    if (cur !== null) {
      if (cur.key !== `${opts.origin}\n${opts.userId}`) throw new CryptoError('Unsupported', 'one crypto Worker serves one user and origin: dispose the client and create a new one')
      // After a sign-out or a revocation the store is gone: build fresh services on it.
      if (cur.identity.status().state !== 'revoked') return cur.identity.status()
    }
    const p = build(opts)
    initializing = p
    try {
      return await p
    } finally {
      if (initializing === p) initializing = null
    }
  }

  /** Async, but it queues before its first await: events of one group keep their order. */
  async function onGatewayEvent(raw: CryptoGatewayEvent): Promise<void> {
    const e = checkEvent(raw)
    const svc = s()
    if (GROUP_EVENTS.has(e.t)) {
      const key = e.t === 'DEVICE_INBOX' ? 'inbox' : `g:${String((e.d as { groupId?: unknown }).groupId)}`
      await serial(key, () => svc.groups.onGatewayEvent(e))
    } else if (IDENTITY_EVENTS.has(e.t)) {
      await svc.identity.onGatewayEvent(e)
    }
    // Any other type is from a newer contract: nothing here consumes it.
  }

  const api: CryptoApi = {
    init,
    status: () =>
      Promise.resolve(
        services?.identity.status() ?? { state: 'needs_identity', userId: null, deviceId: null, primary: false, recoveryConfigured: false, hostTrust: 'server_code' },
      ),
    signOutDevice: () => s().identity.signOutDevice(),

    setupFirstDevice: () => s().identity.setupFirstDevice(),
    restoreFromRecoveryKey: (k) => s().identity.restoreFromRecoveryKey(k),
    resetIdentity: () => s().identity.resetIdentity(),
    rotateRecoveryKey: () => s().identity.rotateRecoveryKey(),

    linkAsNewDevice: (mode) => s().identity.linkAsNewDevice(mode),
    linkScan: (p) => s().identity.linkScan(p),
    linkAccept: (id) => s().identity.linkAccept(id),
    listLinkSessions: () => s().identity.listLinkSessions(),
    linkConfirmSas: (id, m) => s().identity.linkConfirmSas(id, m),
    linkCancel: (id) => s().identity.linkCancel(id),

    listDevices: () => s().identity.listDevices(),
    revokeDevice: (id, reason) => s().identity.revokeDevice(id, reason),
    renameDevice: (id, name) => s().identity.renameDevice(id, name),

    getTrust: (u) => s().identity.getTrust(u),
    listContactDevices: (u) => s().identity.listContactDevices(u),
    getSafetyNumber: (u) => s().identity.getSafetyNumber(u),
    verifyQr: (p) => s().identity.verifyQr(p),
    setVerified: (u, v) => s().identity.setVerified(u, v),
    acknowledgeKeyChange: (u) => s().identity.acknowledgeKeyChange(u),
    getEpochCode: (g) => s().groups.getEpochCode(g),

    sync: () => s().groups.sync(),
    onGatewayEvent,
    ensureChannelGroup: (channelId) => {
      const svc = s()
      return serial(`c:${channelId}`, () => svc.groups.ensureChannelGroup(channelId))
    },
    membershipTimeline: (c, limit) => s().groups.membershipTimeline(c, limit),

    encryptMessage: (input) => {
      const svc = s()
      return serial(`c:${input.channelId}`, () => svc.messages.encryptMessage(input))
    },
    decryptMessages: (m) => s().messages.decryptMessages(m),
    buildReport: (m) => s().messages.buildReport(m),

    encryptAttachment: (i) => s().messages.encryptAttachment(i),
    decryptAttachment: (p, b) => s().messages.decryptAttachment(p, b),

    backupNow: () => s().identity.backupNow(),
    ktSelfCheck: () => s().identity.ktSelfCheck(),
    signAdminAction: (g, t, p) => s().admin.signAdminAction(g, t, p),
    proveDevice: (input) => s().identity.proveDevice(input),

    voiceStart: (o) => s().voice.voiceStart(o),
    voiceHandle: (h, op) => s().voice.voiceHandle(h, op),
    voiceAttachTransform: (h, port) => s().voice.voiceAttachTransform(h, port),
    voiceDetachTransform: (id) => s().voice.voiceDetachTransform(id),
    voiceRoster: (h) => s().voice.voiceRoster(h),
    voiceEpochCode: (h) => s().voice.voiceEpochCode(h),
    voiceStop: (h) => s().voice.voiceStop(h),
  }

  return {
    api,
    async idle() {
      await Promise.all([...queues.values()])
      await services?.groups.idle()
    },
  }
}
