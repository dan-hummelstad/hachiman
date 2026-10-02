/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-empty-function, @typescript-eslint/no-this-alias, @typescript-eslint/prefer-optional-chain, @typescript-eslint/no-unnecessary-type-parameters, @typescript-eslint/no-unsafe-argument, @typescript-eslint/unbound-method -- a synchronous fake behind async interfaces */
/**
 * Test doubles for the identity service specs: an in-memory CryptoStore and a fake Takusen that
 * applies the §12.12 device and key rules. Not part of the package exports.
 */
import type {
  AdminPermissionModel,
  CryptoEvents,
  CryptoGatewayEvent,
  CryptoStore,
  DeviceRevocation,
  DsTransport,
  EngineContext,
  InitOptions,
  MasterKeyRecord,
  RevocationReasonName,
  StoreSchema,
  WireAdminAction,
  WireDevice,
  WireInboxItem,
  WireKtTreeHead,
  WireLinkMessage,
} from '../api'
import { fromB64url, toB64url } from '../codec'
import { DeviceRevocationReason, LINK_SESSION_TTL_MS } from '../constants'
import { kt } from '../kt/index'
import { generateEd25519 } from '../sign'
import { equalBytes, randomBytes } from './bytes'
import { identity, verifyDeviceCert, verifyDskCert, verifyMasterSelfSignature } from './index'
import { createIdentityService } from './service'

export class MemoryStore implements CryptoStore {
  tables = new Map<string, Map<string, unknown>>()
  destroyed = 0
  private t(name: string): Map<string, unknown> {
    let m = this.tables.get(name)
    if (!m) this.tables.set(name, (m = new Map()))
    return m
  }
  async open(): Promise<void> {}
  async get<T extends keyof StoreSchema>(table: T, key: string): Promise<StoreSchema[T] | undefined> {
    const v = this.t(table).get(key)
    return v === undefined ? undefined : (structuredClone(v) as StoreSchema[T])
  }
  async put<T extends keyof StoreSchema>(table: T, key: string, value: StoreSchema[T]): Promise<void> {
    this.t(table).set(key, structuredClone(value))
  }
  async delete<T extends keyof StoreSchema>(table: T, key: string): Promise<void> {
    this.t(table).delete(key)
  }
  async list<T extends keyof StoreSchema>(table: T, prefix = ''): Promise<{ key: string; value: StoreSchema[T] }[]> {
    return [...this.t(table)].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, value: structuredClone(v) as StoreSchema[T] }))
  }
  async transaction<R>(_tables: (keyof StoreSchema)[], fn: (tx: Pick<CryptoStore, 'get' | 'put' | 'delete' | 'list'>) => Promise<R>): Promise<R> {
    return fn(this)
  }
  async destroy(): Promise<void> {
    this.tables.clear()
    this.destroyed++
  }
  close(): void {}
}

export class DsError extends Error {
  readonly code = 'Transport'
  constructor(readonly dsCode: string) {
    super(dsCode)
  }
}

interface MasterRow {
  record: Uint8Array
  superseded: boolean
  ktIndex: number | null
}
interface UserRow {
  masters: MasterRow[]
  dsk: { generation: number; cert: Uint8Array; ktIndex: number | null } | null
}
interface DeviceRow extends WireDevice {
  ktIndex: number | null
  revocationKtIndex: number | null
}

const REASON_NAME: Record<number, RevocationReasonName> = { 1: 'user', 2: 'lost', 3: 'password_reset', 4: 'compromised', 5: 'signed_out' }

export class FakeDs {
  now = 1_700_000_000_000
  devices = new Map<string, DeviceRow>()
  users = new Map<string, UserRow>()
  keyPackages = new Map<string, { count: number; lastResort: boolean }>()
  uploads: { deviceId: string; count: number; lastResort: boolean }[] = []
  inbox = new Map<string, WireInboxItem[]>()
  backups = new Map<string, { keyId: string | null; items: { id: string; kind: 'identity' | 'history'; groupId: string | null; epochFrom: number | null; epochTo: number | null; blob: string; createdAt: string }[] }>()
  links = new Map<string, { userId: string; newDeviceId: string; offer: string; createdAt: string; expiresAtMs: number; peer: string | null; messages: WireLinkMessage[] }>()
  adminActions = new Map<string, WireAdminAction[]>()
  /** Rewrites a link message body in transit (MITM tests). */
  tamperLink: ((body: Uint8Array, from: string) => Uint8Array) | null = null
  /** Rewrites GET /users/:id/keys answers (downgrade tests). */
  tamperKeys: ((k: Awaited<ReturnType<DsTransport['getUserKeys']>>) => Awaited<ReturnType<DsTransport['getUserKeys']>>) | null = null
  ktEnabled = false
  ktKey = generateEd25519()
  ktEntries: { index: number; userId: string; type: 1 | 2 | 3 | 4; entry: Uint8Array; leaf: Uint8Array }[] = []
  ktHeads: WireKtTreeHead[] = []
  dsKey = generateEd25519()
  private seq = 0
  private listeners = new Map<string, (e: CryptoGatewayEvent) => Promise<void>>()
  private queue: { deviceId: string; event: CryptoGatewayEvent }[] = []

  id(): string {
    const b = randomBytes(16)
    b[6] = (b[6]! & 0x0f) | 0x40
    b[8] = (b[8]! & 0x3f) | 0x80
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }

  subscribe(deviceId: string, fn: (e: CryptoGatewayEvent) => Promise<void>): void {
    this.listeners.set(deviceId, fn)
  }
  private publish(deviceIds: Iterable<string>, event: CryptoGatewayEvent): void {
    for (const deviceId of deviceIds) this.queue.push({ deviceId, event })
  }
  private userDevices(userId: string, except?: string): string[] {
    return [...this.devices.values()].filter((d) => d.userId === userId && d.status !== 'revoked' && d.id !== except).map((d) => d.id)
  }
  private allDevices(): string[] {
    return [...this.devices.values()].filter((d) => d.status !== 'revoked').map((d) => d.id)
  }
  /** Delivers queued gateway events until none are left. */
  async flush(): Promise<void> {
    for (let i = 0; i < 1000 && this.queue.length > 0; i++) {
      const { deviceId, event } = this.queue.shift()!
      await this.listeners.get(deviceId)?.(event)
    }
  }

  private user(userId: string): UserRow {
    let u = this.users.get(userId)
    if (!u) this.users.set(userId, (u = { masters: [], dsk: null }))
    return u
  }
  private currentMaster(userId: string): MasterKeyRecord | null {
    const row = this.user(userId).masters.find((m) => !m.superseded)
    return row ? identity.decodeMasterKeyRecord(row.record) : null
  }
  private ktAppend(userId: string, type: 1 | 2 | 3 | 4, object: Uint8Array): number | null {
    if (!this.ktEnabled) return null
    const entry = kt.encodeEntry({ type, userId, timestampMs: this.now, object })
    const index = this.ktEntries.length
    this.ktEntries.push({ index, userId, type, entry, leaf: kt.leafHash(entry) })
    return index
  }
  /** The gRPC tree-head timer: signs a head and tells the owners of new entries. */
  signHead(): WireKtTreeHead {
    const leaves = this.ktEntries.map((e) => e.leaf)
    const prev = this.ktHeads[this.ktHeads.length - 1]?.treeSize ?? 0
    const h = kt.signTreeHead(this.ktKey.privateKey, { treeSize: leaves.length, timestampMs: this.now, rootHash: kt.rootHash(leaves) })
    const wire: WireKtTreeHead = { treeSize: h.treeSize, timestamp: new Date(h.timestampMs).toISOString(), rootHash: toB64url(h.rootHash), signed: toB64url(kt.encodeTreeHead(h)) }
    this.ktHeads.push(wire)
    const owners = new Set(this.ktEntries.slice(prev).map((e) => e.userId))
    for (const u of owners) this.publish(this.userDevices(u), { t: 'KT_TREE_HEAD', d: wire })
    return wire
  }
  /** §12.4 password reset: all devices revoked, the master superseded. */
  passwordReset(userId: string): void {
    for (const d of this.devices.values()) {
      if (d.userId === userId && d.status !== 'revoked') {
        d.status = 'revoked'
        d.revokeReason = 'password_reset'
        this.keyPackages.delete(`${d.id}:1`)
      }
    }
    for (const m of this.user(userId).masters) m.superseded = true
  }

  transport(userId: string): DsTransport & { deviceId: string | null } {
    const ds = this
    const t: DsTransport & { deviceId: string | null } = {
      deviceId: null,
      async registerDevice(body) {
        const id = ds.id()
        const d: DeviceRow = { id, userId, status: 'pending', name: body.name, platform: body.platform, clientVersion: body.clientVersion, certificate: null, revocation: null, revokeReason: null, createdAt: new Date(ds.now).toISOString(), lastSeenAt: null, revokedAt: null, ktIndex: null, revocationKtIndex: null }
        ds.devices.set(id, d)
        t.deviceId = id
        return { ...d }
      },
      async putDeviceCertificate(deviceId, body) {
        const caller = ds.caller(t, userId, true)
        const target = ds.devices.get(deviceId)
        if (!target || target.userId !== userId || target.status === 'revoked') throw new DsError('UnknownDevice')
        if (caller.id !== deviceId && caller.status !== 'active') throw new DsError('DeviceNotActive')
        const bytes = fromB64url(body.certificate)
        const cert = identity.decodeDeviceCertificate(bytes)
        const dsk = ds.user(userId).dsk
        if (!dsk) throw new DsError('InvalidCertificate')
        const dskCert = identity.decodeDskCert(dsk.cert)
        if (cert.deviceId !== deviceId || !verifyDeviceCert(cert, dskCert)) throw new DsError('InvalidCertificate')
        target.certificate = body.certificate
        target.status = 'active'
        target.ktIndex = ds.ktAppend(userId, 3, bytes)
        ds.publish(ds.allDevices(), { t: 'USER_KEYS_UPDATE', d: { userId, kind: 'device_added', deviceId } })
        return { ...target }
      },
      async listOwnDevices() {
        ds.caller(t, userId, true)
        return [...ds.devices.values()].filter((d) => d.userId === userId).map((d) => ({ ...d }))
      },
      async revokeDevice(deviceId, body) {
        const caller = ds.caller(t, userId, true)
        const target = ds.devices.get(deviceId)
        if (!target || target.userId !== userId) throw new DsError('UnknownDevice')
        if (body.revocation === null) {
          if (deviceId !== caller.id || target.status !== 'pending' || body.reason !== 'signed_out') throw new DsError('InvalidRevocation')
        } else {
          const bytes = fromB64url(body.revocation)
          const rev: DeviceRevocation = identity.decodeRevocation(bytes)
          const master = ds.currentMaster(userId)
          const cert = target.certificate ? identity.decodeDeviceCertificate(fromB64url(target.certificate)) : null
          if (!master || rev.deviceId !== deviceId || REASON_NAME[rev.reason] !== body.reason) throw new DsError('InvalidRevocation')
          if (rev.reason === DeviceRevocationReason.SIGNED_OUT && deviceId !== caller.id) throw new DsError('InvalidRevocation')
          if (!identity.verifyRevocation(rev, { master, device: cert })) throw new DsError('InvalidRevocation')
          target.revocation = body.revocation
          target.revocationKtIndex = ds.ktAppend(userId, 4, bytes)
        }
        target.status = 'revoked'
        target.revokeReason = body.reason
        ds.keyPackages.delete(`${deviceId}:1`)
        ds.publish(ds.allDevices(), { t: 'USER_KEYS_UPDATE', d: { userId, kind: 'device_revoked', deviceId } })
      },
      async renameDevice(deviceId, name) {
        ds.caller(t, userId, true)
        const d = ds.devices.get(deviceId)
        if (!d || d.userId !== userId) throw new DsError('UnknownDevice')
        d.name = name
        return { ...d }
      },
      async getUserKeys(target) {
        const u = ds.user(target)
        const entry = (i: number | null) => (i === null ? null : toB64url(ds.ktEntries[i]!.entry))
        const cur = u.masters.find((m) => !m.superseded) ?? null
        const keys = {
          userId: target,
          masterKey: cur ? { generation: identity.decodeMasterKeyRecord(cur.record).generation, record: toB64url(cur.record), ktIndex: cur.ktIndex, ktEntry: entry(cur.ktIndex) } : null,
          deviceSigningKey: u.dsk && cur ? { generation: u.dsk.generation, cert: toB64url(u.dsk.cert), ktIndex: u.dsk.ktIndex, ktEntry: entry(u.dsk.ktIndex) } : null,
          devices: [...ds.devices.values()]
            .filter((d) => d.userId === target)
            .map((d) => ({ id: d.id, status: d.status, certificate: d.certificate, revocation: d.revocation, ktIndex: d.ktIndex, ktEntry: entry(d.ktIndex), revocationKtIndex: d.revocationKtIndex, revocationKtEntry: entry(d.revocationKtIndex) })),
        }
        return ds.tamperKeys ? ds.tamperKeys(keys) : keys
      },
      async putMasterKey(body) {
        ds.caller(t, userId, true)
        const recordBytes = fromB64url(body.record)
        const rec = identity.decodeMasterKeyRecord(recordBytes)
        const dskBytes = fromB64url(body.dskCert)
        const dsk = identity.decodeDskCert(dskBytes)
        if (rec.userId !== userId || !verifyMasterSelfSignature(rec) || !verifyDskCert(dsk, rec)) throw new DsError('InvalidCertificate')
        const u = ds.user(userId)
        const current = u.masters.find((m) => !m.superseded)
        const latest = u.masters[u.masters.length - 1]
        if (u.masters.length === 0) {
          u.masters.push({ record: recordBytes, superseded: false, ktIndex: ds.ktAppend(userId, 1, recordBytes) })
        } else if (!current) {
          if (equalBytes(latest!.record, recordBytes)) latest!.superseded = false
          else if (rec.prevSignature === null && rec.generation === identity.decodeMasterKeyRecord(latest!.record).generation + 1) {
            u.masters.push({ record: recordBytes, superseded: false, ktIndex: ds.ktAppend(userId, 1, recordBytes) })
          } else throw new DsError('MasterKeyExists')
        } else {
          const cur = identity.decodeMasterKeyRecord(current.record)
          if (!identity.verifyMasterKeyRecord(rec, cur.publicKey)) throw new DsError('MasterKeyExists')
          current.superseded = true
          u.masters.push({ record: recordBytes, superseded: false, ktIndex: ds.ktAppend(userId, 1, recordBytes) })
        }
        u.dsk = { generation: dsk.generation, cert: dskBytes, ktIndex: ds.ktAppend(userId, 2, dskBytes) }
        ds.publish(ds.allDevices(), { t: 'USER_KEYS_UPDATE', d: { userId, kind: 'master_key_changed', deviceId: null } })
      },
      async putDeviceSigningKey(body) {
        ds.caller(t, userId, false)
        const bytes = fromB64url(body.cert)
        const c = identity.decodeDskCert(bytes)
        const master = ds.currentMaster(userId)
        const u = ds.user(userId)
        if (!master || !verifyDskCert(c, master)) throw new DsError('InvalidCertificate')
        if (c.generation !== (u.dsk?.generation ?? 0) + 1) throw new DsError('StaleDeviceSigningKey')
        u.dsk = { generation: c.generation, cert: bytes, ktIndex: ds.ktAppend(userId, 2, bytes) }
        for (const id of ds.userDevices(userId)) {
          ds.keyPackages.delete(`${id}:1`)
          ds.publish([id], { t: 'KEY_PACKAGES_LOW', d: { deviceId: id, cipherSuite: 1, remaining: 0 } })
        }
        ds.publish(ds.allDevices(), { t: 'USER_KEYS_UPDATE', d: { userId, kind: 'dsk_rotated', deviceId: null } })
      },
      async getDsInfo() {
        return {
          externalSender: toB64url(ds.dsKey.publicKey),
          cipherSuites: [1],
          ktPublicKey: toB64url(ds.ktKey.publicKey),
          ktRequired: ds.ktEnabled,
          limits: { maxEnvelopeBytes: 32768, maxInboxItemBytes: 1 << 20, maxHistoryBundleBytes: 524288, maxBackupBlobBytes: 1 << 20, keyPackageTarget: 100, keyPackageLowWater: 10 },
        }
      },
      async uploadKeyPackages(body) {
        const caller = ds.caller(t, userId, false)
        const k = `${caller.id}:${body.cipherSuite}`
        const cur = ds.keyPackages.get(k) ?? { count: 0, lastResort: false }
        const next = { count: cur.count + body.keyPackages.length, lastResort: cur.lastResort || body.lastResort !== null }
        ds.keyPackages.set(k, next)
        ds.uploads.push({ deviceId: caller.id, count: body.keyPackages.length, lastResort: body.lastResort !== null })
        return { stored: body.keyPackages.length, total: next.count }
      },
      async countKeyPackages() {
        const caller = ds.caller(t, userId, false)
        const c = ds.keyPackages.get(`${caller.id}:1`) ?? { count: 0, lastResort: false }
        return [{ cipherSuite: 1, count: c.count, lastResort: c.lastResort }]
      },
      async fetchInbox(after) {
        const caller = ds.caller(t, userId, false)
        return (ds.inbox.get(caller.id) ?? []).filter((i) => i.seq > after)
      },
      async ackInbox(id) {
        const caller = ds.caller(t, userId, false)
        ds.inbox.set(caller.id, (ds.inbox.get(caller.id) ?? []).filter((i) => i.id !== id))
      },
      async postInbox(deviceId, body) {
        const caller = ds.caller(t, userId, false)
        const target = ds.devices.get(deviceId)
        if (!target || target.userId !== userId) throw new DsError('UnknownDevice')
        const list = ds.inbox.get(deviceId) ?? []
        const item: WireInboxItem = { id: ds.id(), seq: ++ds.seq, kind: body.kind, senderDevice: caller.id, body: body.body, createdAt: new Date(ds.now).toISOString() }
        list.push(item)
        ds.inbox.set(deviceId, list)
        ds.publish([deviceId], { t: 'DEVICE_INBOX', d: { id: item.id, seq: item.seq, kind: item.kind } })
      },
      async getBackups() {
        // A restoring device is still pending: it reads the backups before it can certify itself.
        ds.caller(t, userId, true)
        const b = ds.backups.get(userId) ?? { keyId: null, items: [] }
        return { keyId: b.keyId, items: b.items.map(({ blob, ...rest }) => ({ ...rest, size: fromB64url(blob).length })) }
      },
      async putIdentityBackup(body) {
        ds.caller(t, userId, false)
        const b = ds.backups.get(userId) ?? { keyId: null, items: [] }
        b.keyId = body.keyId
        b.items = b.items.filter((i) => i.kind !== 'identity')
        b.items.push({ id: ds.id(), kind: 'identity', groupId: null, epochFrom: null, epochTo: null, blob: body.blob, createdAt: new Date(ds.now).toISOString() })
        ds.backups.set(userId, b)
      },
      async postHistoryBackup(body) {
        ds.caller(t, userId, false)
        const b = ds.backups.get(userId)
        if (!b || b.keyId !== body.keyId) throw new DsError('WrongBackupKey')
        const id = ds.id()
        b.items.push({ id, kind: 'history', groupId: body.groupId, epochFrom: body.epochFrom, epochTo: body.epochTo, blob: body.blob, createdAt: new Date(ds.now).toISOString() })
        return { id }
      },
      async getBackup(id) {
        ds.caller(t, userId, true)
        const item = ds.backups.get(userId)?.items.find((i) => i.id === id)
        if (!item) throw new DsError('NotFound')
        return { blob: item.blob }
      },
      async deleteBackups() {
        ds.caller(t, userId, false)
        ds.backups.delete(userId)
      },
      async createLinkSession(body) {
        const caller = ds.caller(t, userId, true)
        const id = ds.id()
        const expiresAtMs = ds.now + LINK_SESSION_TTL_MS
        ds.links.set(id, { userId, newDeviceId: caller.id, offer: body.offer, createdAt: new Date(ds.now).toISOString(), expiresAtMs, peer: null, messages: [] })
        ds.publish(ds.userDevices(userId, caller.id), { t: 'DEVICE_LINK', d: { sessionId: id, seq: 0, fromDevice: caller.id } })
        return { id, expiresAt: new Date(expiresAtMs).toISOString() }
      },
      async listLinkSessions() {
        ds.caller(t, userId, true)
        return [...ds.links]
          .filter(([, s]) => s.userId === userId && s.expiresAtMs > ds.now)
          .map(([id, s]) => ({ id, newDeviceId: s.newDeviceId, offer: s.offer, createdAt: s.createdAt, expiresAt: new Date(s.expiresAtMs).toISOString() }))
      },
      async postLinkMessage(sessionId, body) {
        const caller = ds.caller(t, userId, true)
        const s = ds.links.get(sessionId)
        if (!s || s.userId !== userId || s.expiresAtMs <= ds.now) throw new DsError('LinkExpired')
        if (caller.id !== s.newDeviceId && s.peer === null) s.peer = caller.id
        const bytes = ds.tamperLink ? ds.tamperLink(fromB64url(body.body), caller.id) : fromB64url(body.body)
        const m: WireLinkMessage = { seq: s.messages.length + 1, fromDevice: caller.id, body: toB64url(bytes), createdAt: new Date(ds.now).toISOString() }
        s.messages.push(m)
        const to = caller.id === s.newDeviceId ? (s.peer !== null ? [s.peer] : ds.userDevices(userId, caller.id)) : [s.newDeviceId]
        ds.publish(to, { t: 'DEVICE_LINK', d: { sessionId, seq: m.seq, fromDevice: caller.id } })
        return { seq: m.seq }
      },
      async fetchLinkMessages(sessionId, after) {
        ds.caller(t, userId, true)
        const s = ds.links.get(sessionId)
        if (!s || s.userId !== userId) throw new DsError('LinkExpired')
        return s.messages.filter((m) => m.seq > after)
      },
      async deleteLinkSession(sessionId) {
        ds.links.delete(sessionId)
      },
      async ktTreeHead() {
        const h = ds.ktHeads[ds.ktHeads.length - 1]
        if (!h) throw new DsError('NotFound')
        return h
      },
      async ktInclusion(index, treeSize) {
        return { leafIndex: index, treeSize, auditPath: kt.inclusionProof(ds.ktEntries.map((e) => e.leaf), index, treeSize).map(toB64url) }
      },
      async ktConsistency(from, to) {
        return { from, to, proof: kt.consistencyProof(ds.ktEntries.map((e) => e.leaf), from, to).map(toB64url) }
      },
      async ktEntries(q) {
        return ds.ktEntries
          .filter((e) => e.userId === q.userId && e.index > q.after)
          .slice(0, 1000)
          .map((e) => ({ index: e.index, userId: e.userId, type: e.type, entry: toB64url(e.entry), createdAt: new Date(ds.now).toISOString() }))
      },
      async adminActions(guildId, after) {
        return (ds.adminActions.get(guildId) ?? []).filter((a) => a.seq > after)
      },
      listGroups: unsupported,
      getGroup: unsupported,
      getGroupForChannel: unsupported,
      getGroupState: unsupported,
      createGroup: unsupported,
      postCommit: unsupported,
      fetchHandshakes: unsupported,
      postJoinRequest: unsupported,
      getJoinRequest: unsupported,
      declineBatch: unsupported,
      postHistoryBundle: unsupported,
      getHistoryBundles: unsupported,
      channelReaders: unsupported,
      guildMembers: unsupported,
    }
    return t
  }

  /** The X-Hachiman-Device check (§12.12). */
  caller(t: { deviceId: string | null }, userId: string, allowPending: boolean): DeviceRow {
    if (t.deviceId === null) throw new DsError('DeviceRequired')
    const d = this.devices.get(t.deviceId)
    if (!d || d.userId !== userId || d.status === 'revoked' || (!allowPending && d.status !== 'active')) throw new DsError('DeviceNotActive')
    return d
  }

  /** Stores a client-signed admin action, as the role routes do (§12.16). */
  storeAdminAction(guildId: string, headerB64: string): void {
    const list = this.adminActions.get(guildId) ?? []
    const seq = list.length
    list.push({ guildId, seq, action: headerB64, createdAt: new Date(this.now).toISOString() })
    this.adminActions.set(guildId, list)
  }
}

async function unsupported(): Promise<never> {
  throw new DsError('NotInFake')
}

/** The §2 rules in their simplest form, for the specs. */
export const testPermissions: AdminPermissionModel = {
  guildPermissions: (s, userId) => (userId === s.ownerId ? 0x7fffffff : (s.roles.find((r) => r.id === s.guildId)?.permissions ?? 0)),
  channelPermissions: (s, _c, userId) => (userId === s.ownerId ? 0x7fffffff : 0),
  outranks: (s, actor) => actor === s.ownerId,
}

export interface TestDevice {
  svc: ReturnType<typeof createIdentityService>
  store: MemoryStore
  transport: ReturnType<FakeDs['transport']>
  events: { event: keyof CryptoEvents; payload: unknown }[]
  of<K extends keyof CryptoEvents>(k: K): CryptoEvents[K][]
  keyPackageCalls: { count: number; lastResort: boolean; dskGeneration: number }[]
  dskRotations: number
  init: InitOptions
}

export async function makeDevice(ds: FakeDs, userId: string, deviceName: string, store = new MemoryStore()): Promise<TestDevice> {
  const transport = ds.transport(userId)
  const events: TestDevice['events'] = []
  const dev: Partial<TestDevice> & { keyPackageCalls: TestDevice['keyPackageCalls']; dskRotations: number } = { keyPackageCalls: [], dskRotations: 0 }
  const registerDevice = transport.registerDevice
  transport.registerDevice = async (body) => {
    const d = await registerDevice(body)
    ds.subscribe(d.id, (e) => dev.svc!.onGatewayEvent(e))
    return d
  }
  const ctx: EngineContext = {
    store,
    transport,
    emit: (event, payload) => void events.push({ event, payload }),
    now: () => ds.now,
    random: randomBytes,
    origin: 'https://takusen.test',
    platform: 'electron',
    clientVersion: '1.0.0',
  }
  const svc = createIdentityService(ctx, {
    mls: {
      async generateKeyPackages(input) {
        dev.keyPackageCalls.push({ count: input.count, lastResort: input.lastResort, dskGeneration: input.chain.dsk.generation })
        return Array.from({ length: input.count }, () => ({ publicPackage: randomBytes(40), privatePackage: randomBytes(40), ref: randomBytes(16) }))
      },
    },
    adminPermissions: testPermissions,
  })
  svc.onDskRotated(() => void dev.dskRotations++)
  const init: InitOptions = { userId, wrapKey: {} as CryptoKey, platform: 'electron', clientVersion: '1.0.0', deviceName, origin: ctx.origin }
  const loaded = await svc.load(init)
  if (loaded !== null) {
    transport.deviceId = loaded.deviceId
    ds.subscribe(loaded.deviceId, (e) => svc.onGatewayEvent(e))
  }
  Object.assign(dev, { svc, store, transport, events, init, of: <K extends keyof CryptoEvents>(k: K) => events.filter((e) => e.event === k).map((e) => e.payload as CryptoEvents[K]) })
  return dev as TestDevice
}
