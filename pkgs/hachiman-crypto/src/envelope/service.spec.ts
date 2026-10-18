import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import type {
  CryptoEvents,
  CryptoStore,
  DecryptResult,
  DeviceCertificate,
  DeviceId,
  DsTransport,
  EncryptedMessage,
  EncryptMessageInput,
  EncryptMessageOutput,
  EngineContext,
  GroupService,
  IdentityService,
  MessageService,
  SelfIdentity,
  StoreSchema,
  UserId,
} from '../api'
import { CryptoError } from '../api'
import { DsError, FakeDs, makeDevice, type TestDevice } from '../identity/test-helpers'
import { KEY_REFRESH_MIN_MS } from '../identity/service'
import { fromB64url, toB64url } from '../codec'
import { MAX_ENVELOPE_BYTES } from '../constants'
import { franking } from '../franking'
import { generateEd25519, signWithLabel } from '../sign'
import { decodeEnvelope, decodePlaintext, encodeEnvelope, encodeHeader, encodePlaintext } from './codec'
import { bytes, pointer, thumbnail, uuid } from './fixtures'
import { envelope, envelopeSignedContent } from './index'
import { createMessageService, seenKey } from './service'

// MARK: - Fakes

class MemoryStore implements CryptoStore {
  readonly tables = new Map<string, Map<string, unknown>>()
  private t(name: string): Map<string, unknown> {
    let m = this.tables.get(name)
    if (m === undefined) this.tables.set(name, (m = new Map<string, unknown>()))
    return m
  }
  open(): Promise<void> {
    return Promise.resolve()
  }
  get<T extends keyof StoreSchema>(table: T, key: string): Promise<StoreSchema[T] | undefined> {
    return Promise.resolve(structuredClone(this.t(table).get(key)) as StoreSchema[T] | undefined)
  }
  put<T extends keyof StoreSchema>(table: T, key: string, value: StoreSchema[T]): Promise<void> {
    this.t(table).set(key, structuredClone(value))
    return Promise.resolve()
  }
  delete(table: keyof StoreSchema, key: string): Promise<void> {
    this.t(table).delete(key)
    return Promise.resolve()
  }
  list<T extends keyof StoreSchema>(table: T, prefix = ''): Promise<{ key: string; value: StoreSchema[T] }[]> {
    return Promise.resolve([...this.t(table)].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value: structuredClone(value) as StoreSchema[T] })))
  }
  transaction<R>(_tables: (keyof StoreSchema)[], fn: (tx: Pick<CryptoStore, 'get' | 'put' | 'delete' | 'list'>) => Promise<R>): Promise<R> {
    return fn(this)
  }
  destroy(): Promise<void> {
    this.tables.clear()
    return Promise.resolve()
  }
  close(): void {
    // Nothing to release in memory.
  }
}

const CHANNEL = uuid(100)
const OTHER_CHANNEL = uuid(101)
const ALICE = uuid(1)
const BOB = uuid(2)
const CAROL = uuid(3)
const ALICE_DEV = uuid(11)
const ALICE_DEV2 = uuid(12)
const BOB_DEV = uuid(21)
const CAROL_DEV = uuid(31)

interface Device {
  userId: UserId
  deviceId: DeviceId
  keys: ReturnType<typeof generateEd25519>
  leaf: number
  cert: DeviceCertificate
}

function device(userId: UserId, deviceId: DeviceId, leaf: number): Device {
  const keys = generateEd25519()
  const cert: DeviceCertificate = {
    userId,
    deviceId,
    mlsSignatureKey: keys.publicKey,
    hpkeKey: bytes(32, 0),
    dskGeneration: 1,
    issuedAtMs: 0,
    displayName: 'test',
    signature: bytes(64, 0),
  }
  return { userId, deviceId, keys, leaf, cert }
}

/** One MLS world: groups, epochs and the S_e that every member derives. */
class World {
  readonly devices = new Map<DeviceId, Device>()
  readonly secrets = new Map<string, Uint8Array>()
  readonly current = new Map<string, number>()
  channelGroup = new Map<string, Uint8Array>()
  /** Certificate lookups of these devices reject (a DS outage). */
  readonly failLookups = new Map<DeviceId, Error>()

  add(d: Device): Device {
    this.devices.set(d.deviceId, d)
    return d
  }

  static groupId(n: number): Uint8Array {
    return bytes(22, n)
  }

  setEpoch(groupId: Uint8Array, epoch: number): void {
    this.current.set(toB64url(groupId), epoch)
    for (let e = 0; e <= epoch; e++) {
      const k = `${toB64url(groupId)}:${e}`
      if (!this.secrets.has(k)) this.secrets.set(k, crypto.getRandomValues(new Uint8Array(32)))
    }
  }
}

/** A member's view of the world: what this device can read. */
interface View {
  /** Epochs per group this device holds keys for; absent = all. */
  limits: Map<string, { from: number; to: number }>
  /** Groups this device never held. */
  unknown: Set<string>
  /** Observed leaves; absent = from the world. */
  leafOverride: Map<string, number | null>
  aeadReports: { groupId: string; epoch: number; device: DeviceId }[]
  forkedSecret: boolean
  /** groupId:deviceId → the first epoch without the leaf, after an observed Remove. */
  removedAt: Map<string, number>
  /** Devices that this view knows as revoked. */
  revoked: Set<DeviceId>
}

function makeGroups(world: World, self: Device, view: View): GroupService {
  const unimplemented = (): never => {
    throw new Error('not used')
  }
  return {
    sync: unimplemented,
    ensureChannelGroup: unimplemented,
    membershipTimeline: unimplemented,
    getEpochCode: unimplemented,
    onGatewayEvent: unimplemented,
    resyncAll: unimplemented,
    channelRoster: unimplemented,
    exportHistoryKeys: unimplemented,
    importHistoryKeys: unimplemented,
    descriptor: unimplemented,
    appendTimeline: unimplemented,
    attachInvites: unimplemented,
    sendState(channelId) {
      const groupId = world.channelGroup.get(channelId)!
      const epoch = world.current.get(toB64url(groupId))!
      return Promise.resolve({ groupId, epoch, ownLeaf: self.leaf, epochSecret: world.secrets.get(`${toB64url(groupId)}:${epoch}`)! })
    },
    epochSecret(groupId, epoch) {
      const g = toB64url(groupId)
      if (view.unknown.has(g)) return Promise.resolve(null)
      const lim = view.limits.get(g)
      if (lim !== undefined && (epoch < lim.from || epoch > lim.to)) return Promise.resolve(null)
      if (view.forkedSecret) return Promise.resolve(bytes(32, 0xee))
      return Promise.resolve(world.secrets.get(`${g}:${epoch}`) ?? null)
    },
    currentEpoch(groupId) {
      const g = toB64url(groupId)
      if (view.unknown.has(g)) return Promise.resolve(null)
      const lim = view.limits.get(g)
      return Promise.resolve(lim !== undefined ? lim.to : (world.current.get(g) ?? null))
    },
    leafAt(groupId, deviceId, epoch) {
      const k = `${toB64url(groupId)}:${deviceId}:${epoch}`
      if (view.leafOverride.has(k)) return Promise.resolve(view.leafOverride.get(k)!)
      return Promise.resolve(world.devices.get(deviceId)?.leaf ?? null)
    },
    removedAt(groupId, deviceId) {
      return Promise.resolve(view.removedAt.get(`${toB64url(groupId)}:${deviceId}`) ?? null)
    },
    reportAeadFailure(groupId, epoch, senderDevice) {
      view.aeadReports.push({ groupId: toB64url(groupId), epoch, device: senderDevice })
      return Promise.resolve()
    },
  }
}

function makeIdentity(world: World, self: Device, gossip: { out: Uint8Array | null; seen: { head: Uint8Array; from: UserId }[] }, view: View): IdentityService {
  const unimplemented = (): never => {
    throw new Error('not used')
  }
  const selfIdentity: SelfIdentity = {
    userId: self.userId,
    deviceId: self.deviceId,
    chain: null as never,
    mlsSignatureKey: self.keys,
    hpkeKey: { publicKey: bytes(32, 0), privateKey: bytes(32, 0) },
    primary: true,
  }
  return {
    setupFirstDevice: unimplemented,
    restoreFromRecoveryKey: unimplemented,
    resetIdentity: unimplemented,
    rotateRecoveryKey: unimplemented,
    linkAsNewDevice: unimplemented,
    linkScan: unimplemented,
    linkAccept: unimplemented,
    listLinkSessions: unimplemented,
    linkConfirmSas: unimplemented,
    linkCancel: unimplemented,
    listDevices: unimplemented,
    revokeDevice: unimplemented,
    renameDevice: unimplemented,
    getTrust: unimplemented,
    getSafetyNumber: unimplemented,
    verifyQr: unimplemented,
    setVerified: unimplemented,
    acknowledgeKeyChange: unimplemented,
    ktSelfCheck: unimplemented,
    signOutDevice: unimplemented,
    proveDevice: unimplemented,
    load: unimplemented,
    status: unimplemented,
    chainContextFor: (_userId, entering) =>
      Promise.resolve({ pinnedMaster: null, currentDsk: null, highestSeenDskGeneration: null, revokedDeviceIds: view.revoked, leaf: null, entering, nowMs: 0 }),
    onGatewayEvent: unimplemented,
    handleInboxItem: unimplemented,
    onDskRotated: unimplemented,
    adminState: unimplemented,
    replenishKeyPackages: unimplemented,
    backupNow: unimplemented,
    self: () => selfIdentity,
    deviceCertificate: (userId, deviceId) => {
      const cert = world.devices.get(deviceId)?.cert ?? null
      return Promise.resolve(cert?.userId === userId ? cert : null)
    },
    // The verified certificate of the device, whoever owns it (the service compares the user).
    deviceOwnerCertificate: (deviceId) => {
      const fail = world.failLookups.get(deviceId)
      if (fail !== undefined) return Promise.reject(fail)
      return Promise.resolve(world.devices.get(deviceId)?.cert ?? null)
    },
    listContactDevices: unimplemented,
    trustOf: () => Promise.resolve('tofu'),
    treeHeadForGossip: () => Promise.resolve(gossip.out),
    observeTreeHead: (head, from) => {
      gossip.seen.push({ head, from })
      return Promise.resolve()
    },
  }
}

interface Peer {
  dev: Device
  svc: MessageService
  store: MemoryStore
  view: View
  gossip: { out: Uint8Array | null; seen: { head: Uint8Array; from: UserId }[] }
  clock: { now: number }
  events: { event: keyof CryptoEvents; payload: unknown }[]
}

function peer(world: World, dev: Device, maxEnvelopeBytes = MAX_ENVELOPE_BYTES, realIdentity: IdentityService | null = null): Peer {
  const store = new MemoryStore()
  const view: View = { limits: new Map(), unknown: new Set(), leafOverride: new Map(), aeadReports: [], forkedSecret: false, removedAt: new Map(), revoked: new Set() }
  const gossip = { out: null as Uint8Array | null, seen: [] as { head: Uint8Array; from: UserId }[] }
  const clock = { now: 1_700_000_000_000 }
  const events: Peer['events'] = []
  const transport = {
    getDsInfo: () =>
      Promise.resolve({
        externalSender: '',
        cipherSuites: [1],
        ktPublicKey: '',
        ktRequired: false,
        limits: { maxEnvelopeBytes, maxInboxItemBytes: 0, maxHistoryBundleBytes: 0, maxBackupBlobBytes: 0, keyPackageTarget: 100, keyPackageLowWater: 10 },
      }),
  } as Partial<DsTransport> as DsTransport
  const ctx: EngineContext = {
    store,
    transport,
    emit: (event, payload) => events.push({ event, payload }),
    now: () => clock.now,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    origin: 'https://takusen.test',
    platform: 'browser',
    clientVersion: '1.0.0',
  }
  const svc = createMessageService(ctx, realIdentity ?? makeIdentity(world, dev, gossip, view), makeGroups(world, dev, view))
  return { dev, svc, store, view, gossip, clock, events }
}

let nextId = 1
/** What the server stores for a send (§12.8.4). */
function row(out: EncryptMessageOutput, author: Device, channelId = CHANNEL, attachments: { id: string; size: number }[] = []): EncryptedMessage {
  return {
    id: uuid(10_000 + nextId++),
    channelId,
    guildId: null,
    authorId: author.userId,
    senderDevice: author.deviceId,
    groupId: out.groupId,
    epoch: out.epoch,
    clientMsgId: out.clientMsgId,
    envelope: out.envelope,
    attachments,
    createdAt: '2026-10-02T00:00:00Z',
    editedAt: null,
  }
}

/** What the server stores after a PATCH: the row keeps id, author and attachments. */
function patched(orig: EncryptedMessage, out: EncryptMessageOutput, sender: Device): EncryptedMessage {
  return { ...orig, envelope: out.envelope, groupId: out.groupId, epoch: out.epoch, senderDevice: sender.deviceId, editedAt: '2026-10-02T00:01:00Z' }
}

function setup() {
  const world = new World()
  const alice = world.add(device(ALICE, ALICE_DEV, 0))
  const alice2 = world.add(device(ALICE, ALICE_DEV2, 3))
  const bob = world.add(device(BOB, BOB_DEV, 1))
  const carol = world.add(device(CAROL, CAROL_DEV, 2))
  const g1 = World.groupId(1)
  world.channelGroup.set(CHANNEL, g1)
  world.channelGroup.set(OTHER_CHANNEL, g1)
  world.setEpoch(g1, 5)
  return { world, g1, alice: peer(world, alice), alice2: peer(world, alice2), bob: peer(world, bob), carol: peer(world, carol) }
}

type MsgInput = Extract<EncryptMessageInput, { kind: 'message' | 'edit' }>

function msg(text = 'hi', over: Partial<MsgInput['content']> = {}): MsgInput {
  return { channelId: CHANNEL, kind: 'message', editOf: null, content: { text, mentions: [], attachments: [], replyTo: null, ...over } }
}

function edit(of: string, text: string, over: Partial<MsgInput['content']> = {}): MsgInput {
  return { channelId: CHANNEL, kind: 'edit', editOf: of, content: { text, mentions: [], attachments: [], replyTo: null, ...over } }
}

async function one(p: Peer, m: EncryptedMessage): Promise<DecryptResult> {
  return (await p.svc.decryptMessages([m]))[0]!
}

function reason(r: DecryptResult): string {
  return r.status === 'ok' ? 'ok' : `${r.status}:${r.reason}`
}

// MARK: - Tests

describe('MessageService', () => {
  it('encrypts and decrypts a message', async () => {
    const { alice, carol } = setup()
    alice.gossip.out = bytes(40, 9)
    const out = await alice.svc.encryptMessage(msg('hello', { mentions: [{ type: 'user', id: CAROL }] }))
    expect(fromB64url(out.clientMsgId)).toHaveLength(16)
    expect(out.epoch).toBe(5)
    const r = await one(carol, row(out, alice.dev))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok' || r.kind !== 'message') throw new Error('not a message')
    expect(r.content.text).toBe('hello')
    expect(r.content.mentions).toEqual([{ type: 'user', id: CAROL }])
    expect(r.content.sentAtMs).toBe(alice.clock.now)
    expect(r.sender).toEqual({ userId: ALICE, deviceId: ALICE_DEV, leafIndex: 0, trust: 'tofu', membershipVerified: true })
    expect(carol.gossip.seen).toEqual([{ head: bytes(40, 9), from: ALICE }])
  })

  it('sets membershipVerified false when the client did not see the device hold the leaf', async () => {
    const { alice, carol, g1 } = setup()
    const out = await alice.svc.encryptMessage(msg())
    carol.view.leafOverride.set(`${toB64url(g1)}:${ALICE_DEV}:5`, null)
    const r = await one(carol, row(out, alice.dev))
    expect(r.status === 'ok' && r.sender.membershipVerified).toBe(false)
  })

  it('step 4: rejects a revoked device at or after the observed Remove, accepts older epochs', async () => {
    const { alice, carol, g1 } = setup()
    const out = await alice.svc.encryptMessage(msg())
    carol.view.revoked.add(ALICE_DEV)
    carol.view.removedAt.set(`${toB64url(g1)}:${ALICE_DEV}`, 5)
    expect(reason(await one(carol, row(out, alice.dev)))).toBe('failed:invalid_chain')
    // The Remove was processed at epoch 6: epoch 5 is before it, so the envelope stays valid.
    carol.view.removedAt.set(`${toB64url(g1)}:${ALICE_DEV}`, 6)
    expect(reason(await one(carol, row(out, alice.dev)))).toBe('ok')
  })

  it('step 4: a removed device that is not revoked is not bounded', async () => {
    const { alice, carol, g1 } = setup()
    const out = await alice.svc.encryptMessage(msg())
    carol.view.removedAt.set(`${toB64url(g1)}:${ALICE_DEV}`, 5)
    expect(reason(await one(carol, row(out, alice.dev)))).toBe('ok')
  })

  it('step 1: maps each header/row difference to its code', async () => {
    const { alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg())
    const base = row(out, alice.dev)
    expect(reason(await one(carol, { ...base, envelope: 'AAAA' }))).toBe('failed:malformed')
    expect(reason(await one(carol, { ...base, envelope: '***' }))).toBe('failed:malformed')
    expect(reason(await one(carol, { ...base, channelId: OTHER_CHANNEL }))).toBe('failed:wrong_channel')
    expect(reason(await one(carol, { ...base, groupId: toB64url(World.groupId(2)) }))).toBe('failed:wrong_group')
    expect(reason(await one(carol, { ...base, epoch: 4 }))).toBe('failed:wrong_group')
    expect(reason(await one(carol, { ...base, clientMsgId: toB64url(bytes(16, 1)) }))).toBe('failed:replay')
    expect(reason(await one(carol, { ...base, senderDevice: BOB_DEV }))).toBe('failed:device_mismatch')
    expect(reason(await one(carol, { ...base, senderDevice: null }))).toBe('failed:device_mismatch')
    expect(reason(await one(carol, base))).toBe('ok')
  })

  it('tampering with each header field fails with its code', async () => {
    const { alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg())
    const base = row(out, alice.dev)
    const { header, ciphertext } = decodeEnvelope(fromB64url(out.envelope))
    const tamper = (h: Partial<typeof header>): string => toB64url(encodeEnvelope(encodeHeader({ ...header, ...h }), ciphertext))
    // A server that rewrites the header and the row together still hits the AEAD (the header is the AAD).
    const cases: [Partial<typeof header>, Partial<EncryptedMessage>, string][] = [
      [{ channelId: OTHER_CHANNEL }, {}, 'failed:wrong_channel'],
      [{ channelId: OTHER_CHANNEL }, { channelId: OTHER_CHANNEL }, 'failed:aead'],
      [{ groupId: World.groupId(2) }, {}, 'failed:wrong_group'],
      [{ epoch: 4 }, {}, 'failed:wrong_group'],
      [{ epoch: 4 }, { epoch: 4 }, 'failed:aead'],
      [{ senderLeaf: 1 }, {}, 'failed:aead'],
      [{ senderDeviceId: BOB_DEV }, {}, 'failed:device_mismatch'],
      [{ senderDeviceId: BOB_DEV }, { senderDevice: BOB_DEV }, 'failed:aead'],
      [{ clientMsgId: bytes(16, 3) }, {}, 'failed:replay'],
      [{ clientMsgId: bytes(16, 3) }, { clientMsgId: toB64url(bytes(16, 3)) }, 'failed:aead'],
      [{ salt: bytes(32, 3) }, {}, 'failed:aead'],
      [{ frankingTag: bytes(32, 3) }, {}, 'failed:aead'],
    ]
    for (const [h, r, want] of cases) {
      expect(reason(await one(carol, { ...base, ...r, envelope: tamper(h) })), JSON.stringify(Object.keys(h))).toBe(want)
    }
    expect(carol.view.aeadReports.length).toBeGreaterThan(0)
    expect(carol.view.aeadReports[0]!.device).toBe(ALICE_DEV)
  })

  it('a replay under a new message id gives replay', async () => {
    const { alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg())
    const first = row(out, alice.dev)
    const [a, b] = await carol.svc.decryptMessages([first, { ...first, id: uuid(99_999) }])
    expect(reason(a!)).toBe('ok')
    expect(reason(b!)).toBe('failed:replay')
    // The same row again is fine (a history reload).
    expect(reason(await one(carol, first))).toBe('ok')
  })

  it('a forged sender gives bad_signature or device_mismatch', async () => {
    const { world, alice, bob, carol } = setup()
    // Bob holds S_e and claims Alice's device: the signature does not verify under Alice's key.
    const forger = peer(world, { ...bob.dev, deviceId: ALICE_DEV, leaf: 0 })
    const forged = await forger.svc.encryptMessage(msg('I am Alice'))
    expect(reason(await one(carol, row(forged, alice.dev)))).toBe('failed:bad_signature')
    // The server attributes Bob's real message to Alice.
    const real = await bob.svc.encryptMessage(msg('from bob'))
    expect(reason(await one(carol, { ...row(real, bob.dev), authorId: ALICE }))).toBe('failed:device_mismatch')
  })

  it('a device without a certificate gives invalid_chain', async () => {
    const { world, alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg())
    world.devices.delete(ALICE_DEV)
    expect(reason(await one(carol, row(out, alice.dev)))).toBe('failed:invalid_chain')
  })

  it('a franking tag that does not match the content gives bad_franking', async () => {
    const { world, alice, carol, g1 } = setup()
    const out = await alice.svc.encryptMessage(msg())
    const env = fromB64url(out.envelope)
    const { header, headerBytes, ciphertext } = decodeEnvelope(env)
    const se = world.secrets.get(`${toB64url(g1)}:5`)!
    const key = await envelope.deriveMessageKey(se, header.salt, header.senderLeaf)
    const k = await crypto.subtle.importKey('raw', new Uint8Array(key), 'AES-GCM', false, ['decrypt', 'encrypt'])
    const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: new Uint8Array(headerBytes) }, k, new Uint8Array(ciphertext)))
    const p = decodePlaintext(pt)
    // Alice's device signs a header whose tag commits to other content.
    const badHeader = { ...header, frankingTag: await franking.tag({ frankingKey: p.frankingKey, channelId: CHANNEL, clientMsgId: header.clientMsgId, content: bytes(5, 1) }) }
    const hb = encodeHeader(badHeader)
    const sig = signWithLabel(alice.dev.keys.privateKey, 'Envelope', envelopeSignedContent(hb, p.contentBytes))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: new Uint8Array(12), additionalData: new Uint8Array(hb) }, k, new Uint8Array(encodePlaintext(p.contentBytes, p.frankingKey, sig))))
    const forged = toB64url(encodeEnvelope(hb, ct))
    expect(reason(await one(carol, { ...row(out, alice.dev), envelope: forged }))).toBe('failed:bad_franking')
  })

  it('decrypts edits, including from another device of the author', async () => {
    const { alice, alice2, carol } = setup()
    const out = await alice.svc.encryptMessage(msg('v1'))
    const orig = row(out, alice.dev)
    expect(reason(await one(carol, orig))).toBe('ok')
    alice2.clock.now += 1000
    const e = await alice2.svc.encryptMessage(edit(out.clientMsgId, 'v2'))
    expect(e.clientMsgId).toBe(out.clientMsgId)
    const r = await one(carol, patched(orig, e, alice2.dev))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok' || r.kind !== 'edit') throw new Error('not an edit')
    expect(r.editOf).toBe(out.clientMsgId)
    expect(r.content.text).toBe('v2')
    expect(r.sender.deviceId).toBe(ALICE_DEV2)
  })

  it('an edit by another user gives edit_not_author', async () => {
    const { alice, bob, carol } = setup()
    const out = await alice.svc.encryptMessage(msg('v1'))
    const orig = row(out, alice.dev)
    expect(reason(await one(carol, orig))).toBe('ok')
    bob.clock.now += 1000
    const e = await bob.svc.encryptMessage(edit(out.clientMsgId, 'pwned'))
    expect(reason(await one(carol, patched(orig, e, bob.dev)))).toBe('failed:edit_not_author')
  })

  it('attachments: the pointer ids and blob sizes must equal the row, file then thumbnail', async () => {
    const { alice, carol } = setup()
    const p1 = pointer(1, { thumbnail: thumbnail(2, { blobSize: 777 }) })
    const p2 = pointer(3)
    const out = await alice.svc.encryptMessage(msg('pics', { attachments: [p1, p2] }))
    const rows = [
      { id: uuid(1), size: p1.blobSize },
      { id: uuid(2), size: 777 },
      { id: uuid(3), size: p2.blobSize },
    ]
    const base = row(out, alice.dev, CHANNEL, rows)
    expect(reason(await one(carol, base))).toBe('ok')
    const variants = [
      [rows[1]!, rows[0]!, rows[2]!],
      [rows[0]!, rows[2]!],
      [...rows, { id: uuid(4), size: 1 }],
      [rows[0]!, { ...rows[1]!, size: 778 }, rows[2]!],
      [],
    ]
    for (const v of variants) expect(reason(await one(carol, { ...base, id: uuid(50_000 + v.length), attachments: v }))).toBe('failed:attachments_mismatch')
  })

  it('an edit that changes the attachments gives attachments_mismatch', async () => {
    const { alice, carol } = setup()
    const p1 = pointer(1)
    const out = await alice.svc.encryptMessage(msg('pic', { attachments: [p1] }))
    const orig = row(out, alice.dev, CHANNEL, [{ id: uuid(1), size: p1.blobSize }])
    expect(reason(await one(carol, orig))).toBe('ok')
    alice.clock.now += 1000
    const swapped = await alice.svc.encryptMessage(edit(out.clientMsgId, 'pic', { attachments: [pointer(5)] }))
    expect(reason(await one(carol, patched(orig, swapped, alice.dev)))).toBe('failed:attachments_mismatch')
    const dropped = await alice.svc.encryptMessage(edit(out.clientMsgId, 'no pic'))
    expect(reason(await one(carol, patched(orig, dropped, alice.dev)))).toBe('failed:attachments_mismatch')
    const kept = await alice.svc.encryptMessage(edit(out.clientMsgId, 'same pic', { attachments: [p1] }))
    expect(reason(await one(carol, patched(orig, kept, alice.dev)))).toBe('ok')
  })

  it('an older edit, or the original re-served after an edit, gives stale_edit', async () => {
    const { alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg('v1'))
    const orig = row(out, alice.dev)
    alice.clock.now += 1000
    const e1 = patched(orig, await alice.svc.encryptMessage(edit(out.clientMsgId, 'v2')), alice.dev)
    alice.clock.now += 1000
    const e2 = patched(orig, await alice.svc.encryptMessage(edit(out.clientMsgId, 'v3')), alice.dev)
    expect((await carol.svc.decryptMessages([orig, e1, e2])).map(reason)).toEqual(['ok', 'ok', 'ok'])
    expect(reason(await one(carol, e1))).toBe('failed:stale_edit')
    expect(reason(await one(carol, orig))).toBe('failed:stale_edit')
    // The newest version again is the same envelope: accepted.
    expect(reason(await one(carol, e2))).toBe('ok')
    const seen = await carol.store.get('seen', seenKey(CHANNEL, out.clientMsgId))
    expect(seen).toEqual({ messageId: orig.id, sentAtMs: alice.clock.now })
  })

  it('an edit keeps sent_at_ms above the version this client saw, even when the clock goes back', async () => {
    const { alice } = setup()
    const out = await alice.svc.encryptMessage(msg('v1'))
    const orig = row(out, alice.dev)
    expect(reason(await one(alice, orig))).toBe('ok')
    alice.clock.now -= 60_000
    const e = patched(orig, await alice.svc.encryptMessage(edit(out.clientMsgId, 'v2')), alice.dev)
    const r = await one(alice, e)
    expect(r.status === 'ok' && r.content.sentAtMs).toBe(alice.clock.now + 60_000 + 1)
  })

  it('an edit in a new group after a channel move decrypts', async () => {
    const { world, alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg('v1'))
    const orig = row(out, alice.dev)
    expect(reason(await one(carol, orig))).toBe('ok')
    const g2 = World.groupId(2)
    world.setEpoch(g2, 0)
    world.channelGroup.set(CHANNEL, g2)
    alice.clock.now += 1000
    const e = await alice.svc.encryptMessage(edit(out.clientMsgId, 'v2'))
    expect(e.groupId).toBe(toB64url(g2))
    const r = await one(carol, patched(orig, e, alice.dev))
    expect(r.status === 'ok' && r.kind === 'edit' && r.content.text).toBe('v2')
  })

  it('step 2: epoch ahead is pending and buffered; group_unknown and no_history_key', async () => {
    const { world, alice, carol, g1 } = setup()
    world.setEpoch(g1, 7)
    const out = await alice.svc.encryptMessage(msg())
    const m = row(out, alice.dev)
    carol.view.limits.set(toB64url(g1), { from: 0, to: 6 })
    expect(await one(carol, m)).toEqual({ status: 'pending', messageId: m.id, reason: 'epoch_ahead' })
    await one(carol, m)
    expect(await carol.store.get('buffered', toB64url(g1))).toEqual({ messages: [m] })

    // A known group without the key of an old epoch.
    carol.view.limits.set(toB64url(g1), { from: 8, to: 9 })
    expect(reason(await one(carol, m))).toBe('pending:no_history_key')

    // A group this device never held.
    carol.view.limits.delete(toB64url(g1))
    carol.view.unknown.add(toB64url(g1))
    expect(reason(await one(carol, m))).toBe('pending:group_unknown')
    // The same, but with a stored epoch secret (a bundle or a backup): no_history_key.
    await carol.store.put('epochSecrets', `${toB64url(g1)}:1`, { groupId: g1, epoch: 1, secret: bytes(32, 1), backedUp: false })
    expect(reason(await one(carol, m))).toBe('pending:no_history_key')
  })

  it('step 3: an AEAD failure is reported for the fork alert', async () => {
    const { alice, carol, g1 } = setup()
    const out = await alice.svc.encryptMessage(msg())
    carol.view.forkedSecret = true
    expect(reason(await one(carol, row(out, alice.dev)))).toBe('failed:aead')
    expect(carol.view.aeadReports).toEqual([{ groupId: toB64url(g1), epoch: 5, device: ALICE_DEV }])
  })

  it('throws TooLarge for an oversize content, before it seals', async () => {
    const { world, alice } = setup()
    await expect(alice.svc.encryptMessage(msg('a'.repeat(8001)))).rejects.toMatchObject({ code: 'TooLarge' })
    const small = peer(world, alice.dev, 400)
    await expect(small.svc.encryptMessage(msg('a'.repeat(300)))).rejects.toMatchObject({ code: 'TooLarge' })
    await expect(small.svc.encryptMessage(msg('a'.repeat(10)))).resolves.toBeDefined()
    // The limit is exact: an envelope of exactly the limit passes.
    const exact = await small.svc.encryptMessage(msg('a'.repeat(10)))
    const size = fromB64url(exact.envelope).length
    const tight = peer(world, alice.dev, size)
    await expect(tight.svc.encryptMessage(msg('a'.repeat(10)))).resolves.toBeDefined()
    await expect(tight.svc.encryptMessage(msg('a'.repeat(11)))).rejects.toMatchObject({ code: 'TooLarge' })
  })

  it('rejects a bad edit request', async () => {
    const { alice } = setup()
    await expect(alice.svc.encryptMessage({ ...msg(), kind: 'edit', editOf: null })).rejects.toBeInstanceOf(CryptoError)
    await expect(alice.svc.encryptMessage({ ...msg(), editOf: toB64url(bytes(16, 0)) })).rejects.toBeInstanceOf(CryptoError)
    await expect(alice.svc.encryptMessage(edit(toB64url(bytes(15, 0)), 'x'))).rejects.toBeInstanceOf(CryptoError)
  })

  it('encrypts and decrypts a reaction and a page activity (kinds 3 and 4)', async () => {
    const { alice, carol } = setup()
    const target = (await alice.svc.encryptMessage(msg('react to me'))).clientMsgId
    const out = await alice.svc.encryptMessage({ channelId: CHANNEL, kind: 'reaction', editOf: null, content: { target, emoji: '🔥', remove: false } })
    expect(out.clientMsgId).not.toBe(target)
    const r = await one(carol, row(out, alice.dev))
    if (r.status !== 'ok' || r.kind !== 'reaction') throw new Error(reason(r))
    expect(r.content).toEqual({ target, emoji: '🔥', remove: false, sentAtMs: alice.clock.now })
    expect(r.editOf).toBeNull()

    const pageId = uuid(500)
    const pa = await alice.svc.encryptMessage({ channelId: CHANNEL, kind: 'page_activity', editOf: null, content: { pageId, changes: 3 } })
    const p = await one(carol, row(pa, alice.dev))
    if (p.status !== 'ok' || p.kind !== 'page_activity') throw new Error(reason(p))
    expect(p.content).toEqual({ pageId, changes: 3, sentAtMs: alice.clock.now })
  })

  it('kinds 3 and 4: no editOf, no attachments on the row, never edited, author checked', async () => {
    const { alice, bob, carol } = setup()
    const target = toB64url(bytes(16, 0x42))
    const react = { channelId: CHANNEL, kind: 'reaction', editOf: null, content: { target, emoji: '👍', remove: true } } as const
    const bad = { ...react, editOf: target } as unknown as EncryptMessageInput
    await expect(alice.svc.encryptMessage(bad)).rejects.toMatchObject({ code: 'Malformed' })
    await expect(alice.svc.encryptMessage({ ...react, content: { ...react.content, emoji: 'x\u0000' } })).rejects.toMatchObject({ code: 'Malformed' })
    await expect(alice.svc.encryptMessage({ channelId: CHANNEL, kind: 'page_activity', editOf: null, content: { pageId: uuid(5), changes: 0 } })).rejects.toMatchObject({ code: 'Malformed' })

    const out = await alice.svc.encryptMessage(react)
    expect(reason(await one(carol, row(out, alice.dev, CHANNEL, [{ id: uuid(900), size: 10 }])))).toBe('failed:attachments_mismatch')
    expect(reason(await one(carol, { ...row(out, alice.dev), editedAt: '2026-10-02T00:01:00Z' }))).toBe('failed:malformed')
    // Bob's reaction, attributed to Alice by the server.
    const forged = await bob.svc.encryptMessage(react)
    expect(reason(await one(carol, { ...row(forged, bob.dev), authorId: ALICE }))).toBe('failed:device_mismatch')
  })

  it('buildReport opens a message that franking verifies', async () => {
    const { alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg('report me'))
    const m = row(out, alice.dev)
    const rep = await carol.svc.buildReport(m)
    const { header } = decodeEnvelope(fromB64url(out.envelope))
    const ok = await franking.verify({
      frankingTag: header.frankingTag,
      frankingKey: fromB64url(rep.frankingKey),
      channelId: CHANNEL,
      clientMsgId: header.clientMsgId,
      content: fromB64url(rep.content),
    })
    expect(ok).toBe(true)
    const reported = envelope.decodeContent(fromB64url(rep.content))
    expect(reported.kind === 'message' && reported.content.text).toBe('report me')
    await expect(carol.svc.buildReport({ ...m, channelId: OTHER_CHANNEL })).rejects.toMatchObject({ code: 'Malformed' })
  })

  it('encrypts and decrypts attachments with thumbnails', async () => {
    const { alice, carol } = setup()
    const file = new Blob([Uint8Array.from({ length: 70_000 }, (_, i) => (i * 31 + 7) & 0xff)])
    const thumb = new Blob([crypto.getRandomValues(new Uint8Array(3000))])
    const enc = await alice.svc.encryptAttachment({
      file,
      name: 'photo.jpg',
      mime: 'Image/JPEG; q=1',
      width: 4000,
      height: 3000,
      durationMs: null,
      blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
      thumbnail: { blob: thumb, mime: 'image/webp', width: 320, height: 240 },
    })
    expect(enc.draft.size).toBe(70_000)
    expect(enc.draft.blobSize).toBe(enc.blob.size)
    expect(enc.draft.mime).toBe('image/jpeg')
    expect(enc.draft.thumbnail!.size).toBe(3000)
    expect(enc.draft.thumbnail!.blobSize).toBe(enc.thumbnailBlob!.size)
    const out = await carol.svc.decryptAttachment(enc.draft, enc.blob)
    expect(new Uint8Array(await out.arrayBuffer())).toEqual(new Uint8Array(await file.arrayBuffer()))
    expect(out.type).toBe('image/jpeg')
    const t = await carol.svc.decryptAttachment(enc.draft.thumbnail!, enc.thumbnailBlob!)
    expect(new Uint8Array(await t.arrayBuffer())).toEqual(new Uint8Array(await thumb.arrayBuffer()))
    // A pointer of the wrong blob fails closed.
    await expect(carol.svc.decryptAttachment(enc.draft, enc.thumbnailBlob!)).rejects.toMatchObject({ code: 'Malformed' })
    await expect(carol.svc.decryptAttachment({ ...enc.draft, key: 'not base64!' }, enc.blob)).rejects.toMatchObject({ code: 'Malformed' })
  })

  it('encryptAttachment rejects a field that breaks a pointer limit', async () => {
    const { alice } = setup()
    const base = { file: new Blob(['x']), mime: 'text/plain', width: null, height: null, durationMs: null, blurhash: null, thumbnail: null }
    await expect(alice.svc.encryptAttachment({ ...base, name: '' })).rejects.toBeInstanceOf(CryptoError)
    await expect(alice.svc.encryptAttachment({ ...base, name: 'n'.repeat(256) })).rejects.toMatchObject({ code: 'TooLarge' })
    const ok = await alice.svc.encryptAttachment({ ...base, name: 'a.txt', mime: '' })
    expect(ok.draft.mime).toBe('application/octet-stream')
  })

  it('a DS error marks only its own message pending, with one error event per batch', async () => {
    const { world, alice, bob, carol } = setup()
    const a1 = row(await alice.svc.encryptMessage(msg('a1')), alice.dev)
    const b1 = row(await bob.svc.encryptMessage(msg('b1')), bob.dev)
    const a2 = row(await alice.svc.encryptMessage(msg('a2')), alice.dev)
    world.failLookups.set(ALICE_DEV, new DsError('ServiceUnavailable'))
    const r = await carol.svc.decryptMessages([a1, b1, a2])
    expect(r.map(reason)).toEqual(['pending:transport', 'ok', 'pending:transport'])
    const errors = carol.events.filter((e) => e.event === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.payload).toMatchObject({ code: 'Transport', dsCode: 'ServiceUnavailable' })
    // A CryptoError('Transport') without a dsCode (a fetch that failed) is transient too.
    world.failLookups.set(ALICE_DEV, new CryptoError('Transport', 'network down'))
    expect(reason(await one(carol, a1))).toBe('pending:transport')
    // The DS is back: the same messages decrypt.
    world.failLookups.clear()
    expect((await carol.svc.decryptMessages([a1, a2])).map(reason)).toEqual(['ok', 'ok'])
  })

  it('a bug in a lookup still rejects the batch (it is not a DS error)', async () => {
    const { world, alice, carol } = setup()
    const a1 = row(await alice.svc.encryptMessage(msg('a1')), alice.dev)
    world.failLookups.set(ALICE_DEV, new TypeError('bug'))
    await expect(carol.svc.decryptMessages([a1])).rejects.toBeInstanceOf(TypeError)
  })

  it('fuzz: decryptMessages never throws on mutated envelopes and never accepts them', async () => {
    const { alice, carol } = setup()
    const out = await alice.svc.encryptMessage(msg('fuzz', { attachments: [pointer(1)] }))
    const env = fromB64url(out.envelope)
    const base = row(out, alice.dev, CHANNEL, [{ id: uuid(1), size: pointer(1).blobSize }])
    let n = 0
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.nat(env.length - 1), fc.integer({ min: 1, max: 255 })), { minLength: 1, maxLength: 4 }), async (edits) => {
        const m = env.slice()
        for (const [i, x] of edits) m[i]! ^= x
        const r = await one(carol, { ...base, id: uuid(70_000 + n++), envelope: toB64url(m) })
        expect(r.status).not.toBe('ok')
      }),
      { numRuns: 300 },
    )
  })
})

// MARK: - With the real IdentityService (certificates verified from a fake Takusen)

describe('MessageService with the real IdentityService', () => {
  async function real() {
    const ds = new FakeDs()
    const users = { alice: ds.id(), bob: ds.id(), carol: ds.id() }
    const devs: Record<keyof typeof users, TestDevice> = {} as never
    for (const k of Object.keys(users) as (keyof typeof users)[]) {
      devs[k] = await makeDevice(ds, users[k], k)
      await devs[k].svc.setupFirstDevice()
    }
    await ds.flush()
    const world = new World()
    const asDevice = (t: TestDevice, leaf: number): Device => {
      const s = t.svc.self()
      return world.add({ userId: s.userId, deviceId: s.deviceId, keys: s.mlsSignatureKey, leaf, cert: s.chain.device })
    }
    const alice = peer(world, asDevice(devs.alice, 0))
    const bob = peer(world, asDevice(devs.bob, 1))
    const carolDev = asDevice(devs.carol, 2)
    const carol = peer(world, carolDev, MAX_ENVELOPE_BYTES, devs.carol.svc)
    const g1 = World.groupId(1)
    world.channelGroup.set(CHANNEL, g1)
    world.setEpoch(g1, 5)
    const keyFetches: UserId[] = []
    const getUserKeys = devs.carol.transport.getUserKeys
    devs.carol.transport.getUserKeys = (userId) => {
      keyFetches.push(userId)
      return getUserKeys(userId)
    }
    return { ds, users, alice, bob, carol, keyFetches }
  }

  it('an edit signed by a foreign device gives edit_not_author', async () => {
    const { alice, bob, carol } = await real()
    const out = await alice.svc.encryptMessage(msg('v1'))
    const orig = row(out, alice.dev)
    expect(reason(await one(carol, orig))).toBe('ok')
    // Carol has Bob's keys (a group member), so his device is known under his user.
    expect(reason(await one(carol, row(await bob.svc.encryptMessage(msg('hello')), bob.dev)))).toBe('ok')
    bob.clock.now += 1000
    const e = await bob.svc.encryptMessage(edit(out.clientMsgId, 'pwned'))
    expect(reason(await one(carol, patched(orig, e, bob.dev)))).toBe('failed:edit_not_author')
  })

  it('a kind-1 message attributed to another user gives device_mismatch, and an unknown owner invalid_chain', async () => {
    const { users, alice, bob, carol } = await real()
    const real1 = await bob.svc.encryptMessage(msg('from bob'))
    // Before Carol knows Bob, nothing proves who owns the device: invalid_chain, fail closed.
    expect(reason(await one(carol, { ...row(real1, bob.dev), authorId: users.alice }))).toBe('failed:invalid_chain')
    expect(reason(await one(carol, row(await bob.svc.encryptMessage(msg('again')), bob.dev)))).toBe('ok')
    const real2 = await bob.svc.encryptMessage(msg('from bob 2'))
    expect(reason(await one(carol, { ...row(real2, bob.dev), authorId: users.alice }))).toBe('failed:device_mismatch')
    expect(reason(await one(carol, row(await alice.svc.encryptMessage(msg('alice')), alice.dev)))).toBe('ok')
  })

  it('an unknown device id refetches the hinted user at most once per KEY_REFRESH_MIN_MS', async () => {
    const { ds, users, bob, carol, keyFetches } = await real()
    const misattributed = async (n: number) => ({ ...row(await bob.svc.encryptMessage(msg(`m${n}`)), bob.dev), authorId: users.alice })
    for (let i = 0; i < 5; i++) expect(reason(await one(carol, await misattributed(i)))).toBe('failed:invalid_chain')
    const aliceFetches = () => keyFetches.filter((u) => u === users.alice).length
    expect(aliceFetches()).toBe(1)
    ds.now += KEY_REFRESH_MIN_MS + 1
    carol.clock.now += KEY_REFRESH_MIN_MS + 1
    expect(reason(await one(carol, await misattributed(9)))).toBe('failed:invalid_chain')
    expect(aliceFetches()).toBe(2)
  })
})
