import { describe, expect, it } from 'vitest'

import type {
  CryptoStore,
  DeviceCertificate,
  DeviceId,
  DocDecryptResult,
  DocEnvelopeKindName,
  DocService,
  EncryptedDocItem,
  EngineContext,
  GroupService,
  IdentityService,
  StoreSchema,
  UserId,
} from '../api'
import { CryptoError } from '../api'
import { fromB64url, toB64url } from '../codec'
import { DOC_ENVELOPE_MAGIC, MAX_DOC_AWARENESS_B64_BYTES, MAX_PAGE_TITLE_BYTES } from '../constants'
import { generateEd25519 } from '../sign'
import { decodeDocEnvelope, decodeSnapshotPointer, docEnvelopeLength, encodeDocContent, encodeHeader } from './codec'
import { sealDocContentBytes } from './doc'
import { createDocService } from './doc-service'
import { bytes, uuid } from './fixtures'
import { deriveDocKeySync, deriveMessageKeySync } from './index'

// MARK: - Fakes

const CHANNEL = uuid(100)
const OTHER_CHANNEL = uuid(101)
const PAGE = uuid(200)
const OTHER_PAGE = uuid(201)
const ALICE = uuid(1)
const BOB = uuid(2)
const ALICE_DEV = uuid(11)
const BOB_DEV = uuid(21)
const GROUP = bytes(22, 7)
const G = toB64url(GROUP)

interface Device {
  userId: UserId
  deviceId: DeviceId
  keys: ReturnType<typeof generateEd25519>
  leaf: number
  cert: DeviceCertificate
}

function device(userId: UserId, deviceId: DeviceId, leaf: number): Device {
  const keys = generateEd25519()
  const cert = { userId, deviceId, mlsSignatureKey: keys.publicKey } as DeviceCertificate
  return { userId, deviceId, keys, leaf, cert }
}

/** One MLS group: the epoch and the S_e that every member derives. */
class World {
  readonly devices = new Map<DeviceId, Device>()
  readonly secrets = new Map<number, Uint8Array>()
  epoch = 0

  constructor() {
    this.advance(0)
  }

  advance(to: number): void {
    for (let e = 0; e <= to; e++) if (!this.secrets.has(e)) this.secrets.set(e, crypto.getRandomValues(new Uint8Array(32)))
    this.epoch = to
  }
}

/** What one device can read. */
interface View {
  /** Epochs this device holds S_e for; absent = all. */
  from: number
  to: number | null
  /** False: not a member any more (removed). */
  member: boolean
  aeadReports: { epoch: number; device: DeviceId }[]
  sendStates: number
}

function memoryStore(): CryptoStore {
  const tables = new Map<string, Map<string, unknown>>()
  const t = (name: string): Map<string, unknown> => {
    let m = tables.get(name)
    if (m === undefined) tables.set(name, (m = new Map<string, unknown>()))
    return m
  }
  const store = {
    get: (table: keyof StoreSchema, key: string) => Promise.resolve(t(table).get(key)),
    put: (table: keyof StoreSchema, key: string, value: unknown) => Promise.resolve(void t(table).set(key, value)),
    delete: (table: keyof StoreSchema, key: string) => Promise.resolve(void t(table).delete(key)),
    list: (table: keyof StoreSchema, prefix = '') => Promise.resolve([...t(table)].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }))),
  }
  return store as unknown as CryptoStore
}

function peer(world: World, self: Device, view: Partial<View> = {}): { docs: DocService; view: View } {
  const v: View = { from: 0, to: null, member: true, aeadReports: [], sendStates: 0, ...view }
  const groups = {
    sendState() {
      v.sendStates++
      return Promise.resolve({ groupId: GROUP, epoch: world.epoch, ownLeaf: self.leaf, epochSecret: world.secrets.get(world.epoch)! })
    },
    epochSecret(_g: Uint8Array, epoch: number) {
      if (epoch < v.from || (v.to !== null && epoch > v.to)) return Promise.resolve(null)
      return Promise.resolve(world.secrets.get(epoch) ?? null)
    },
    currentEpoch: () => Promise.resolve(v.member ? (v.to ?? world.epoch) : null),
    leafAt: (_g: Uint8Array, d: DeviceId) => Promise.resolve(world.devices.get(d)?.leaf ?? null),
    removedAt: () => Promise.resolve(null),
    reportAeadFailure(_g: Uint8Array, epoch: number, d: DeviceId) {
      v.aeadReports.push({ epoch, device: d })
      return Promise.resolve()
    },
  } as unknown as GroupService
  const identity = {
    self: () => ({ userId: self.userId, deviceId: self.deviceId, mlsSignatureKey: self.keys }),
    deviceOwnerCertificate: (d: DeviceId) => Promise.resolve(world.devices.get(d)?.cert ?? null),
    chainContextFor: () => Promise.resolve({ revokedDeviceIds: new Set() }),
    trustOf: () => Promise.resolve('tofu'),
  } as unknown as IdentityService
  const ctx = {
    store: memoryStore(),
    transport: { getDsInfo: () => Promise.resolve({ limits: { maxEnvelopeBytes: 32_768 } }) },
    emit: () => undefined,
    now: () => 1_700_000_000_000,
    random: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
  } as unknown as EngineContext
  return { docs: createDocService(ctx, identity, groups), view: v }
}

function setup() {
  const world = new World()
  const alice = device(ALICE, ALICE_DEV, 0)
  const bob = device(BOB, BOB_DEV, 1)
  world.devices.set(alice.deviceId, alice)
  world.devices.set(bob.deviceId, bob)
  return { world, alice, bob, a: peer(world, alice), b: peer(world, bob) }
}

function item(envelope: string, over: Partial<EncryptedDocItem> = {}): EncryptedDocItem {
  return { id: 'x', channelId: CHANNEL, pageId: PAGE, kind: 'doc_update', senderDevice: ALICE_DEV, envelope, ...over }
}

async function one(docs: DocService, i: EncryptedDocItem): Promise<DocDecryptResult> {
  const [r] = await docs.decryptDoc([i])
  return r!
}

const utf8 = (s: string) => new TextEncoder().encode(s)
const pointerJson = () => utf8(JSON.stringify({ uploadId: uuid(300), fileKey: toB64url(bytes(32, 1)), sha256: toB64url(bytes(32, 2)), size: 4096 }))

// MARK: - Specs

describe('doc envelopes (§12.20)', () => {
  it('two devices round-trip doc_update and doc_snapshot', async () => {
    const { a, b } = setup()
    const update = crypto.getRandomValues(new Uint8Array(500))
    const enc = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_update', bytes: update })
    expect(enc.groupId).toBe(G)
    expect(enc.epoch).toBe(0)
    expect(a.view.sendStates).toBe(1)
    expect(fromB64url(enc.envelope).length).toBe(docEnvelopeLength(update.length))

    const r = await one(b.docs, item(enc.envelope))
    expect(r).toMatchObject({ status: 'ok', id: 'x', kind: 'doc_update', sender: { userId: ALICE, deviceId: ALICE_DEV, leafIndex: 0, trust: 'tofu', membershipVerified: true } })
    expect(r.status === 'ok' && r.bytes).toEqual(update)

    const snap = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_snapshot', bytes: pointerJson() })
    const s = await one(b.docs, item(snap.envelope, { kind: 'doc_snapshot' }))
    expect(s.status).toBe('ok')
    if (s.status === 'ok') expect(decodeSnapshotPointer(s.bytes)).toEqual({ uploadId: uuid(300), fileKey: toB64url(bytes(32, 1)), sha256: toB64url(bytes(32, 2)), size: 4096 })
  })

  it('round-trips a title and awareness, and accepts a null senderDevice', async () => {
    const { a, b } = setup()
    const title = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_title', bytes: utf8('Roadmap ✓') })
    const r = await one(b.docs, item(title.envelope, { kind: 'doc_title', senderDevice: null }))
    expect(r.status === 'ok' && new TextDecoder().decode(r.bytes)).toBe('Roadmap ✓')
    const aw = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_awareness', bytes: bytes(100, 3) })
    expect((await one(b.docs, item(aw.envelope, { kind: 'doc_awareness' }))).status).toBe('ok')
  })

  it('fails an envelope moved to another page or channel', async () => {
    const { a, b } = setup()
    const enc = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_update', bytes: bytes(10, 1) })
    expect(await one(b.docs, item(enc.envelope, { pageId: OTHER_PAGE }))).toEqual({ status: 'failed', id: 'x', reason: 'wrong_page' })
    expect(await one(b.docs, item(enc.envelope, { channelId: OTHER_CHANNEL }))).toEqual({ status: 'failed', id: 'x', reason: 'wrong_channel' })

    // A server that rewrites page_id in the header breaks the AAD.
    const raw = fromB64url(enc.envelope)
    const at = 2 + 1 + 1 + 22 + 16
    raw.set(new Uint8Array(16).fill(0xab), at)
    const moved = decodeDocEnvelope(raw).header.pageId
    expect(await one(b.docs, item(toB64url(raw), { pageId: moved }))).toEqual({ status: 'failed', id: 'x', reason: 'aead' })
    expect(b.view.aeadReports).toEqual([{ epoch: 0, device: ALICE_DEV }])
  })

  it('fails the wrong kind and a foreign sender device', async () => {
    const { a, b } = setup()
    const enc = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_update', bytes: bytes(10, 1) })
    expect(await one(b.docs, item(enc.envelope, { kind: 'doc_snapshot' }))).toEqual({ status: 'failed', id: 'x', reason: 'wrong_kind' })
    expect(await one(b.docs, item(enc.envelope, { senderDevice: BOB_DEV }))).toEqual({ status: 'failed', id: 'x', reason: 'device_mismatch' })
  })

  it('fails a tampered signature and an unknown sender', async () => {
    const { world, alice, b } = setup()
    const mallory = generateEd25519()
    const forged = await sealDocContentBytes(
      {
        header: { kind: 'doc_update', groupId: GROUP, channelId: CHANNEL, pageId: PAGE, epoch: 0, senderLeaf: alice.leaf, senderDeviceId: ALICE_DEV },
        epochSecret: world.secrets.get(0)!,
        signatureKey: mallory.privateKey,
      },
      encodeDocContent(bytes(10, 1), 0),
    )
    expect(await one(b.docs, item(toB64url(forged)))).toEqual({ status: 'failed', id: 'x', reason: 'bad_signature' })

    const stranger = await sealDocContentBytes(
      {
        header: { kind: 'doc_update', groupId: GROUP, channelId: CHANNEL, pageId: PAGE, epoch: 0, senderLeaf: 5, senderDeviceId: uuid(99) },
        epochSecret: world.secrets.get(0)!,
        signatureKey: mallory.privateKey,
      },
      encodeDocContent(bytes(10, 1), 0),
    )
    expect(await one(b.docs, item(toB64url(stranger), { senderDevice: uuid(99) }))).toEqual({ status: 'failed', id: 'x', reason: 'invalid_chain' })
  })

  it('a removed member cannot decrypt the new epoch; old epochs use the retained secret', async () => {
    const { world, a } = setup()
    const old = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_update', bytes: bytes(10, 1) })
    world.advance(1)
    const fresh = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_update', bytes: bytes(10, 2) })
    expect(fresh.epoch).toBe(1)

    const removed = peer(world, device(BOB, BOB_DEV, 1), { to: 0, member: false })
    const r = await one(removed.docs, item(fresh.envelope))
    expect(r).toMatchObject({ status: 'pending', id: 'x' })
    expect('bytes' in r).toBe(false)
    expect((await one(removed.docs, item(old.envelope))).status).toBe('ok')

    // The epoch 0 secret does not open an epoch 1 envelope, even with the header rewritten.
    const raw = fromB64url(fresh.envelope)
    const view = new DataView(raw.buffer, raw.byteOffset)
    view.setBigUint64(2 + 1 + 1 + 22 + 16 + 16, 0n)
    expect(await one(removed.docs, item(toB64url(raw)))).toEqual({ status: 'failed', id: 'x', reason: 'aead' })
  })

  it('gives epoch_ahead for an epoch past the local one', async () => {
    const { world, a } = setup()
    world.advance(2)
    const enc = await a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind: 'doc_update', bytes: bytes(10, 1) })
    const behind = peer(world, device(BOB, BOB_DEV, 1), { to: 1 })
    expect(await one(behind.docs, item(enc.envelope))).toEqual({ status: 'pending', id: 'x', reason: 'epoch_ahead' })
  })

  it('a doc key never equals a message key for the same S_e, salt and leaf', () => {
    const se = crypto.getRandomValues(new Uint8Array(32))
    const salt = crypto.getRandomValues(new Uint8Array(32))
    for (const leaf of [0, 1, 7, 0xffffffff]) expect(toB64url(deriveDocKeySync(se, salt, leaf))).not.toBe(toB64url(deriveMessageKeySync(se, salt, leaf)))
  })

  it('a message envelope never decodes as a doc envelope', async () => {
    const { b } = setup()
    const header = encodeHeader({ groupId: GROUP, channelId: CHANNEL, epoch: 0, senderLeaf: 0, senderDeviceId: ALICE_DEV, clientMsgId: bytes(16, 1), salt: bytes(32, 2), frankingTag: bytes(32, 3) })
    expect(() => decodeDocEnvelope(header)).toThrow(CryptoError)
    expect(await one(b.docs, item(toB64url(header)))).toEqual({ status: 'failed', id: 'x', reason: 'malformed' })
    expect(DOC_ENVELOPE_MAGIC).toBe(0x4802)
  })

  it('rejects bodies that break the kind rules, and oversize envelopes', async () => {
    const { a } = setup()
    const enc = (kind: DocEnvelopeKindName, b: Uint8Array) => a.docs.encryptDoc({ channelId: CHANNEL, pageId: PAGE, kind, bytes: b })
    await expect(enc('doc_title', new Uint8Array(0))).rejects.toMatchObject({ code: 'Malformed' })
    await expect(enc('doc_title', bytes(MAX_PAGE_TITLE_BYTES + 1, 0x61))).rejects.toMatchObject({ code: 'TooLarge' })
    await expect(enc('doc_title', new Uint8Array([0xff]))).rejects.toMatchObject({ code: 'Malformed' })
    await expect(enc('doc_snapshot', utf8('{"uploadId":"nope"}'))).rejects.toMatchObject({ code: 'Malformed' })
    await expect(enc('doc_awareness', bytes(MAX_DOC_AWARENESS_B64_BYTES, 1))).rejects.toMatchObject({ code: 'TooLarge' })
    await expect(enc('doc_update', bytes(32_768, 1))).rejects.toMatchObject({ code: 'TooLarge' })
  })

  it('reports malformed for a signed body that breaks the kind rules', async () => {
    const { world, alice, b } = setup()
    const sealed = await sealDocContentBytes(
      {
        header: { kind: 'doc_title', groupId: GROUP, channelId: CHANNEL, pageId: PAGE, epoch: 0, senderLeaf: alice.leaf, senderDeviceId: ALICE_DEV },
        epochSecret: world.secrets.get(0)!,
        signatureKey: alice.keys.privateKey,
      },
      encodeDocContent(new Uint8Array(0), 0),
    )
    expect(await one(b.docs, item(toB64url(sealed), { kind: 'doc_title' }))).toEqual({ status: 'failed', id: 'x', reason: 'malformed' })
  })
})
