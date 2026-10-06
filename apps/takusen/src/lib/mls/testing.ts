/**
 * Test support for the DS (not imported by production code).
 *
 * `FakeDs` implements DsModule. The identity checks, the KT math and the
 * envelope header codec are the real @hachiman/crypto code. The MLS objects
 * are fakes: a GroupInfo is the real MLSMessage prefix (the DS parses it
 * itself, wire-format.ts) followed by JSON, a ratchet tree is JSON, and a
 * commit is the real PublicMessage prefix followed by JSON. `checkCommit`
 * applies the §12.7.3 checks 2-7 to those fakes, so the Takusen code around it
 * runs as in production.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { decodeDocEnvelope, decodeEnvelope, encodeDocHeader, encodeEnvelope, encodeHeader } from '../../../../../pkgs/hachiman-crypto/src/envelope/codec'
import { identity, verifyDeviceCert, verifyDskCert } from '../../../../../pkgs/hachiman-crypto/src/identity/index'
import { decodeInviteRecord, decodeSignedInviteRecord, inviteRecordView } from '../../../../../pkgs/hachiman-crypto/src/invites/codec'
import { verifyInviteRecordSignature } from '../../../../../pkgs/hachiman-crypto/src/invites/record'
import { kt } from '../../../../../pkgs/hachiman-crypto/src/kt/index'

import { bytesEqual, fromB64, Reader, toB64 } from './bytes'
import { dsConfig, FALSE_REJECTION_LIMIT, type DsConfig } from './config'
import type { CommitterStrikes, DsDeps, Presence, RateLimiter } from './context'
import type { CommitInspection, DeviceChain, DsModule, DsSigner, GroupDescriptor, LeafEntry } from './crypto'
import { GROUP_CONTEXT_EXTENSIONS, REQUIRED_CAPABILITIES } from './groups'
import { ed25519PublicKey } from './keys'
import type { DeviceRow, GroupRow } from './repo'
import { InMemoryMlsRepo } from './repo.in-memory'
import { encodeForTests, parseGroupInfoContext, parsePublicMessagePrefix } from './wire-format'

const te = new TextEncoder()
const td = new TextDecoder()

// MARK: - Fake MLS objects

export interface FakeLeaf {
  leafIndex: number
  userId: string
  deviceId: string
  signatureKey: string // b64
  dskGeneration: number
  chainValid?: boolean
}

export interface FakeGroupInfoRest {
  signatureValid?: boolean
  treeHashValid?: boolean
  externalPub?: boolean
  signerLeaf: number
  descriptor: GroupDescriptor | null
  extensions?: { types: number[]; externalSenders: string | null; requiredCapabilities: string | null }
}

export interface FakeCommitRest {
  refs: string[]
  /** Adds by value (key packages), with the leaf index that the add takes. */
  adds: { leafIndex: number; keyPackage: string }[]
  removes: number[]
  /** External commit: the new leaf, and the own leaf that a resync removes. */
  external?: { leaf: FakeLeaf; resyncOf: number | null }
  descriptor?: GroupDescriptor | null
}

function afterGroupContext(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes)
  r.u16()
  r.u16()
  r.u16()
  r.u16()
  r.opaque()
  r.u64()
  r.opaque()
  r.opaque()
  return bytes.subarray(bytes.length - r.remaining)
}

function afterMessagePrefix(bytes: Uint8Array): Uint8Array {
  const r = new Reader(bytes)
  r.u16()
  r.u16()
  r.opaque()
  r.u64()
  const t = r.u8()
  if (t === 1 || t === 2) r.u32()
  r.opaque()
  r.u8()
  return bytes.subarray(bytes.length - r.remaining)
}

export function fakeTree(leaves: FakeLeaf[]): Uint8Array {
  return te.encode(JSON.stringify({ leaves }))
}

export function readTree(tree: Uint8Array): FakeLeaf[] {
  return (JSON.parse(td.decode(tree)) as { leaves: FakeLeaf[] }).leaves
}

export function fakeGroupInfo(groupId: Uint8Array, epoch: number, cipherSuite: number, rest: FakeGroupInfoRest): Uint8Array {
  return encodeForTests.groupInfo(
    { cipherSuite, groupId, epoch, treeHash: randomBytes(32), confirmedTranscriptHash: randomBytes(32) },
    te.encode(JSON.stringify(rest)),
  )
}

export function readGroupInfo(gi: Uint8Array): FakeGroupInfoRest {
  return JSON.parse(td.decode(afterGroupContext(gi))) as FakeGroupInfoRest
}

export function fakeCommit(groupId: Uint8Array, epoch: number, senderLeaf: number | null, rest: FakeCommitRest): Uint8Array {
  return encodeForTests.publicMessagePrefix({ groupId, epoch, senderLeaf, contentType: 3 }, te.encode(JSON.stringify(rest)))
}

interface FakeKeyPackage {
  kp: string
  userId: string
  deviceId: string
  cipherSuite: number
  signatureKey: string
  dskGeneration: number
  notAfterMs: number
}

export function fakeKeyPackage(device: Pick<DeviceRow, 'id' | 'userId' | 'mlsSignatureKey' | 'dskGeneration'>, cipherSuite = 1, notAfterMs = Date.now() + 30 * 86_400_000): Uint8Array {
  const kp: FakeKeyPackage = {
    kp: randomUUID(),
    userId: device.userId,
    deviceId: device.id,
    cipherSuite,
    signatureKey: toB64(device.mlsSignatureKey!),
    dskGeneration: device.dskGeneration ?? 1,
    notAfterMs,
  }
  return te.encode(JSON.stringify(kp))
}

function readKeyPackage(b: Uint8Array): FakeKeyPackage {
  const kp = JSON.parse(td.decode(b)) as FakeKeyPackage
  if (!kp.kp) throw new Error('not a key package')
  return kp
}

export function leafOfKeyPackage(b: Uint8Array, leafIndex: number): FakeLeaf {
  const kp = readKeyPackage(b)
  return { leafIndex, userId: kp.userId, deviceId: kp.deviceId, signatureKey: kp.signatureKey, dskGeneration: kp.dskGeneration }
}

function fakeChain(l: FakeLeaf): DeviceChain {
  return { master: {} as DeviceChain['master'], dsk: {} as DeviceChain['dsk'], device: { deviceId: l.deviceId, userId: l.userId, dskGeneration: l.dskGeneration, mlsSignatureKey: fromB64(l.signatureKey)! } as DeviceChain['device'] }
}

function toLeafEntry(l: FakeLeaf): LeafEntry {
  return { leafIndex: l.leafIndex, userId: l.userId, deviceId: l.deviceId, signatureKey: fromB64(l.signatureKey)!, chain: l.chainValid === false ? null : fakeChain(l) }
}

const sameLeaf = (a: FakeLeaf, b: FakeLeaf) => a.userId === b.userId && a.deviceId === b.deviceId && a.signatureKey === b.signatureKey

// MARK: - FakeDs

type FakeProposal = { op: 'remove'; leaf: number } | { op: 'add'; keyPackage: string }

export class FakeDs implements DsModule {
  /** Every proposal the fake signed, by ref. Only test helpers (`transition`) read it; checkCommit does not. */
  readonly proposals = new Map<string, FakeProposal>()
  /** Every checkCommit call, for assertions. */
  readonly checks: Parameters<DsModule['checkCommit']>[0][] = []
  kt = kt

  async loadSigner(seed: Uint8Array): Promise<DsSigner> {
    const publicKey = ed25519PublicKey(seed)
    return { publicKey, privateKey: seed, externalSender: new Uint8Array([...te.encode('ext:'), ...publicKey]) }
  }

  private proposal(groupInfo: Uint8Array, body: object): Uint8Array {
    const ctx = parseGroupInfoContext(groupInfo)
    const prefix = encodeForTests.publicMessagePrefix({ groupId: ctx.groupId, epoch: ctx.epoch, senderLeaf: 0, contentType: 2 })
    return new Uint8Array([...prefix, ...te.encode(JSON.stringify({ ...body, nonce: randomUUID() }))])
  }

  async proposeRemove(_signer: DsSigner, groupInfo: Uint8Array, leafIndex: number): Promise<Uint8Array> {
    const msg = this.proposal(groupInfo, { op: 'remove', leaf: leafIndex })
    this.proposals.set(toB64(await this.proposalRef(msg)), { op: 'remove', leaf: leafIndex })
    return msg
  }

  async proposeAdd(_signer: DsSigner, groupInfo: Uint8Array, keyPackage: Uint8Array): Promise<Uint8Array> {
    const msg = this.proposal(groupInfo, { op: 'add', keyPackage: toB64(keyPackage) })
    this.proposals.set(toB64(await this.proposalRef(msg)), { op: 'add', keyPackage: toB64(keyPackage) })
    return msg
  }

  async proposalRef(message: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(createHash('sha256').update(message).digest())
  }

  async inspectKeyPackage(bytes: Uint8Array) {
    const kp = readKeyPackage(bytes)
    const leaf: FakeLeaf = { leafIndex: -1, userId: kp.userId, deviceId: kp.deviceId, signatureKey: kp.signatureKey, dskGeneration: kp.dskGeneration }
    return {
      ref: new Uint8Array(createHash('sha256').update(bytes).digest()),
      cipherSuite: kp.cipherSuite as 1,
      userId: kp.userId,
      deviceId: kp.deviceId,
      signatureKey: fromB64(kp.signatureKey)!,
      chain: fakeChain(leaf),
      notAfterMs: kp.notAfterMs,
      signatureValid: true,
    }
  }

  async checkCommit(input: Parameters<DsModule['checkCommit']>[0]) {
    this.checks.push(input)
    const fail = (reason: string) => ({ ok: false as const, reason })
    const prefix = parsePublicMessagePrefix(input.commit)
    if (!bytesEqual(prefix.groupId, input.groupId) || prefix.epoch !== input.epoch) return fail('wrong group or epoch')
    const rest = JSON.parse(td.decode(afterMessagePrefix(input.commit))) as FakeCommitRest
    const prev = readTree(input.previous.ratchetTree)
    const next = readTree(input.ratchetTree)
    const gi = readGroupInfo(input.groupInfo)
    const ctx = parseGroupInfoContext(input.groupInfo)
    if (ctx.epoch !== input.epoch + 1) return fail('GroupInfo epoch is not epoch + 1')
    if (gi.signatureValid === false) return fail('bad GroupInfo signature')
    if (gi.treeHashValid === false) return fail('tree hash mismatch')
    if (gi.externalPub === false) return fail('missing external_pub')

    // 3. The sender credential is the request device.
    let sender: CommitInspection['sender']
    if (prefix.sender.type === 'member') {
      const leaf = prev.find((l) => l.leafIndex === (prefix.sender as { leafIndex: number }).leafIndex)
      if (!leaf || leaf.userId !== input.sender.userId || leaf.deviceId !== input.sender.deviceId) return fail('sender credential is not the request device')
      sender = { type: 'member', leafIndex: leaf.leafIndex }
    } else {
      if (!rest.external || rest.external.leaf.deviceId !== input.sender.deviceId || rest.external.leaf.userId !== input.sender.userId) {
        return fail('external commit leaf is not the request device')
      }
      sender = { type: 'new_member_commit' }
    }

    // 6. Every reference is a published DS proposal. Like ds.ts, the fake gets
    // the signed proposals and applies them: it has no ref-only path.
    const published = new Map<string, FakeProposal>()
    for (const msg of input.publishedProposals) {
      const m = parsePublicMessagePrefix(msg)
      if (m.contentType !== 'proposal' || !bytesEqual(m.groupId, input.groupId) || m.epoch !== input.epoch) return fail('a published item is not a proposal of this epoch')
      published.set(toB64(await this.proposalRef(msg)), JSON.parse(td.decode(afterMessagePrefix(msg))) as FakeProposal)
    }
    const proposalTypes: CommitInspection['proposalTypes'] = []
    const expected = new Map(prev.map((l) => [l.leafIndex, l]))
    const removedLeaves: number[] = []
    const refAdds: string[] = []
    for (const ref of rest.refs) {
      const p = published.get(ref)
      if (!p) return fail('unpublished proposal ref')
      if (p.op === 'remove') {
        expected.delete(p.leaf)
        removedLeaves.push(p.leaf)
        proposalTypes.push('remove')
      } else {
        refAdds.push(p.keyPackage)
        proposalTypes.push('add')
      }
    }
    for (const idx of rest.removes) {
      expected.delete(idx)
      removedLeaves.push(idx)
      proposalTypes.push('remove')
    }
    if (rest.external) {
      proposalTypes.push('external_init')
      if (rest.external.resyncOf !== null) {
        expected.delete(rest.external.resyncOf)
        removedLeaves.push(rest.external.resyncOf)
        proposalTypes.push('remove')
      }
      expected.set(rest.external.leaf.leafIndex, rest.external.leaf)
    }
    for (const a of rest.adds) {
      expected.set(a.leafIndex, leafOfKeyPackage(fromB64(a.keyPackage)!, a.leafIndex))
      proposalTypes.push('add')
    }
    for (const kp of refAdds) {
      let idx = 0
      while (expected.has(idx)) idx++
      expected.set(idx, leafOfKeyPackage(fromB64(kp)!, idx))
    }
    // 5. The roster transition equals the uploaded tree.
    if (next.length !== expected.size || next.some((l) => !expected.has(l.leafIndex) || !sameLeaf(expected.get(l.leafIndex)!, l))) {
      return fail('roster transition mismatch: the tree hides or adds a leaf')
    }
    const changedLeaves = next.filter((l) => {
      const p = prev.find((x) => x.leafIndex === l.leafIndex)
      return !p || !sameLeaf(p, l) || (rest.external?.leaf.leafIndex === l.leafIndex)
    })
    // 7. Chains of new or changed leaves.
    for (const l of changedLeaves) {
      if (l.chainValid === false || !input.masterKeys(l.userId)) return fail(`leaf ${l.leafIndex}: invalid chain`)
    }
    const prevGi = readGroupInfo(input.previous.groupInfo)
    const descriptor = rest.descriptor ?? gi.descriptor
    if (rest.descriptor) proposalTypes.push('group_context_extensions')
    return {
      ok: true as const,
      inspection: {
        groupId: input.groupId,
        epoch: input.epoch,
        sender,
        proposalTypes,
        proposalRefs: rest.refs.map((r) => fromB64(r)!),
        next: { epoch: input.epoch + 1, roster: next.map(toLeafEntry), descriptor, signerLeaf: gi.signerLeaf, hasExternalPub: true },
        changedLeaves: changedLeaves.map((l) => l.leafIndex),
        removedLeaves,
        descriptorChanged: JSON.stringify(descriptor) !== JSON.stringify(prevGi.descriptor),
      },
    }
  }

  async inspectGroupInfo(groupInfo: Uint8Array, ratchetTree: Uint8Array) {
    const ctx = parseGroupInfoContext(groupInfo)
    const gi = readGroupInfo(groupInfo)
    return {
      groupId: ctx.groupId,
      epoch: ctx.epoch,
      cipherSuite: ctx.cipherSuite as 1,
      signatureValid: gi.signatureValid !== false,
      treeHashValid: gi.treeHashValid !== false,
      roster: readTree(ratchetTree).map(toLeafEntry),
      extensions: {
        types: gi.extensions?.types ?? [],
        externalSenders: gi.extensions?.externalSenders ? fromB64(gi.extensions.externalSenders) : null,
        requiredCapabilities: gi.extensions?.requiredCapabilities ? fromB64(gi.extensions.requiredCapabilities) : null,
      },
      descriptor: gi.descriptor,
    }
  }

  async rosterOf(_groupInfo: Uint8Array, ratchetTree: Uint8Array): Promise<LeafEntry[]> {
    return readTree(ratchetTree).map(toLeafEntry)
  }

  verifyDeviceCertificate(cert: Uint8Array, dsk: Uint8Array, master: Uint8Array) {
    try {
      const c = identity.decodeDeviceCertificate(cert)
      const d = identity.decodeDskCert(dsk)
      const m = identity.decodeMasterKeyRecord(master)
      return verifyDskCert(d, m) && verifyDeviceCert(c, d) ? c : null
    } catch {
      return null
    }
  }

  verifyMasterKeyRecord(record: Uint8Array, prev: Uint8Array | null) {
    try {
      const r = identity.decodeMasterKeyRecord(record)
      const p = prev === null ? null : identity.decodeMasterKeyRecord(prev)
      return identity.verifyMasterKeyRecord(r, p?.publicKey ?? null) ? r : null
    } catch {
      return null
    }
  }

  verifyDskCert(cert: Uint8Array, master: Uint8Array) {
    try {
      const d = identity.decodeDskCert(cert)
      const m = identity.decodeMasterKeyRecord(master)
      return verifyDskCert(d, m) ? d : null
    } catch {
      return null
    }
  }

  verifyRevocation(revocation: Uint8Array, keys: { master: Uint8Array; deviceCertificate: Uint8Array | null }) {
    try {
      const r = identity.decodeRevocation(revocation)
      const master = identity.decodeMasterKeyRecord(keys.master)
      const device = keys.deviceCertificate ? identity.decodeDeviceCertificate(keys.deviceCertificate) : null
      return identity.verifyRevocation(r, { master, device }) ? r : null
    } catch {
      return null
    }
  }

  verifyAdminAction(): never {
    throw new Error('not used by the DS tests')
  }
  adminActionHash(): never {
    throw new Error('not used by the DS tests')
  }
  /** The real pure check (§12.11.4). */
  verifyInviteRecord(signedRecord: Uint8Array, creatorCertificate: Uint8Array) {
    try {
      const rec = verifyInviteRecordSignature(signedRecord, identity.decodeDeviceCertificate(creatorCertificate))
      return rec === null ? null : inviteRecordView(rec)
    } catch {
      return null
    }
  }
  /** The real decode (§12.11.4). */
  parseInviteRecord(signedRecord: Uint8Array) {
    return inviteRecordView(decodeInviteRecord(decodeSignedInviteRecord(signedRecord).record))
  }
  parseEnvelopeHeader(envelope: Uint8Array) {
    return decodeEnvelope(envelope).header
  }
  parseDocEnvelopeHeader(envelope: Uint8Array) {
    return decodeDocEnvelope(envelope).header
  }
  verifyFrankingOpening(): boolean {
    throw new Error('not used by the DS tests')
  }
}

export function testEnvelope(h: { groupId: Uint8Array; channelId: string; epoch: number; senderLeaf: number; senderDeviceId: string; clientMsgId?: Uint8Array }): Uint8Array {
  const header = encodeHeader({
    groupId: h.groupId,
    channelId: h.channelId,
    epoch: h.epoch,
    senderLeaf: h.senderLeaf,
    senderDeviceId: h.senderDeviceId,
    clientMsgId: h.clientMsgId ?? new Uint8Array(randomBytes(16)),
    salt: new Uint8Array(randomBytes(32)),
    frankingTag: new Uint8Array(randomBytes(32)),
  })
  return encodeEnvelope(header, new Uint8Array(randomBytes(64)))
}

/** A page envelope (§12.20) with a random ciphertext: the DS reads only the header. */
export function testDocEnvelope(h: {
  kind: 'doc_update' | 'doc_snapshot' | 'doc_awareness' | 'doc_title'
  groupId: Uint8Array
  channelId: string
  pageId: string
  epoch: number
  senderLeaf: number
  senderDeviceId: string
}): Uint8Array {
  return encodeEnvelope(encodeDocHeader({ ...h, salt: new Uint8Array(randomBytes(32)) }), new Uint8Array(randomBytes(64)))
}

// MARK: - World

export class FakePresence implements Presence {
  readonly online = new Set<string>()
  async onlineDevices(ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => this.online.has(id)))
  }
}

export const noRateLimit: RateLimiter = { async hit() {} }

export class FakeStrikes implements CommitterStrikes {
  readonly counts = new Map<string, number>()
  async add(deviceId: string): Promise<number> {
    const n = (this.counts.get(deviceId) ?? 0) + 1
    this.counts.set(deviceId, n)
    return n
  }
  async barred(ids: readonly string[]): Promise<Set<string>> {
    return new Set(ids.filter((id) => (this.counts.get(id) ?? 0) >= FALSE_REJECTION_LIMIT))
  }
}

export interface World {
  repo: InMemoryMlsRepo
  ds: FakeDs
  deps: DsDeps
  presence: FakePresence
  strikes: FakeStrikes
  config: DsConfig
  clock: { now: number }
}

export async function newWorld(env: Record<string, string> = {}): Promise<World> {
  const repo = new InMemoryMlsRepo()
  const ds = new FakeDs()
  const presence = new FakePresence()
  const config = dsConfig(env as NodeJS.ProcessEnv)
  const clock = { now: Date.UTC(2026, 9, 1, 12) }
  repo.clock = () => new Date(clock.now)
  const signer = await ds.loadSigner(new Uint8Array(randomBytes(32)))
  const strikes = new FakeStrikes()
  const deps: DsDeps = { ds, signer, config, presence, rate: noRateLimit, strikes, now: () => new Date(clock.now) }
  return { repo, ds, deps, presence, strikes, config, clock }
}

/** An active, certified device. The master and DSK rows are fakes unless the test makes real ones. */
export async function activeDevice(w: World, userId: string, opts: { online?: boolean } = {}): Promise<DeviceRow> {
  if (!(await w.repo.listMasterKeys(userId)).length) {
    await w.repo.insertMasterKey({ userId, generation: 1, publicKey: new Uint8Array(randomBytes(32)), record: new Uint8Array(randomBytes(8)) })
    await w.repo.insertDsk({ userId, generation: 1, masterGeneration: 1, publicKey: new Uint8Array(randomBytes(32)), cert: new Uint8Array(randomBytes(8)) })
  }
  const d = await w.repo.insertDevice({ userId, name: 'test', platform: 'browser', clientVersion: '1.0.0' })
  const row = await w.repo.updateDevice(d.id, {
    status: 'active',
    certificate: new Uint8Array(randomBytes(8)),
    mlsSignatureKey: new Uint8Array(randomBytes(32)),
    hpkeKey: new Uint8Array(randomBytes(32)),
    dskGeneration: 1,
  })
  if (opts.online !== false) w.presence.online.add(row.id)
  return row
}

export function leafOf(d: DeviceRow, leafIndex: number): FakeLeaf {
  return { leafIndex, userId: d.userId, deviceId: d.id, signatureKey: toB64(d.mlsSignatureKey!), dskGeneration: d.dskGeneration ?? 1 }
}

export function descriptorOf(g: GroupRow, createdBy: string): GroupDescriptor {
  return { kind: g.kind, guildId: g.guildId, channelId: g.kind === 'public_set' ? null : g.channelId, historyVisibility: g.historyVisibility, createdByUserId: createdBy }
}

/** The create upload of §12.7.7 for the assignee `device`, built like a real client. */
export function createRequest(w: World, g: GroupRow, device: DeviceRow, assignmentId: string, override: Partial<FakeGroupInfoRest> = {}, tree?: FakeLeaf[]) {
  const groupInfo = fakeGroupInfo(g.groupId, 0, g.cipherSuite, {
    signerLeaf: 0,
    descriptor: descriptorOf(g, device.userId),
    extensions: { types: [...GROUP_CONTEXT_EXTENSIONS], externalSenders: toB64(w.deps.signer.externalSender), requiredCapabilities: toB64(REQUIRED_CAPABILITIES) },
    ...override,
  })
  return {
    groupId: g.groupId,
    kind: g.kind,
    guildId: g.guildId,
    channelId: g.kind === 'public_set' ? null : g.channelId,
    cipherSuite: g.cipherSuite,
    groupInfo,
    ratchetTree: fakeTree(tree ?? [leafOf(device, 0)]),
    assignmentId,
  }
}

/**
 * The tree after a commit, in the order that FakeDs.checkCommit applies it:
 * referenced Removes, Removes by value, the external commit, Adds by value,
 * then referenced Adds in the lowest free leaves.
 */
export function transition(ds: FakeDs, prev: FakeLeaf[], rest: FakeCommitRest): FakeLeaf[] {
  const next = new Map(prev.map((l) => [l.leafIndex, l]))
  const refAdds: string[] = []
  for (const ref of rest.refs) {
    const p = ds.proposals.get(ref)
    if (p?.op === 'remove') next.delete(p.leaf)
    else if (p?.op === 'add') refAdds.push(p.keyPackage)
  }
  for (const idx of rest.removes) next.delete(idx)
  if (rest.external) {
    if (rest.external.resyncOf !== null) next.delete(rest.external.resyncOf)
    next.set(rest.external.leaf.leafIndex, rest.external.leaf)
  }
  for (const a of rest.adds) next.set(a.leafIndex, leafOfKeyPackage(fromB64(a.keyPackage)!, a.leafIndex))
  for (const kp of refAdds) {
    let idx = 0
    while (next.has(idx)) idx++
    next.set(idx, leafOfKeyPackage(fromB64(kp)!, idx))
  }
  return [...next.values()].sort((a, b) => a.leafIndex - b.leafIndex)
}

/** Lowest free leaf indexes after the removes, for Adds by value. */
export function freeLeaves(tree: FakeLeaf[], removed: number[], count: number): number[] {
  const used = new Set(tree.map((l) => l.leafIndex).filter((i) => !removed.includes(i)))
  const out: number[] = []
  for (let i = 0; out.length < count; i++) if (!used.has(i)) out.push(i)
  return out
}

/** Activates a pending group as the device of its create assignment would (§12.7.7). */
export async function activate(w: World, out: import('./events').Outbox, group: GroupRow, creator: DeviceRow): Promise<GroupRow> {
  const { createGroup } = await import('./groups')
  const batch = (await w.repo.listBatchesOfGroup(group.groupId)).find((b) => b.deviceId === creator.id)
  if (!batch) throw new Error('the creator has no create assignment')
  await createGroup(w.repo, w.deps, out, { userId: creator.userId, device: creator }, createRequest(w, group, creator, batch.id))
  return (await w.repo.getGroup(group.groupId))!
}

/**
 * Commits the live batch of a group as its committer would: every DS proposal
 * by reference and every join by value (with a Welcome). Returns the upload result.
 */
export async function commitLiveBatch(w: World, out: import('./events').Outbox, groupId: Uint8Array, rejected: { pendingId: string; reason: string }[] = []) {
  const { uploadCommit } = await import('./commits')
  const batch = (await w.repo.listBatchesOfGroup(groupId)).find((b) => b.deadlineAt.getTime() > w.clock.now)
  if (!batch) throw new Error('no live batch')
  const committer = (await w.repo.getDevice(batch.deviceId))!
  const items = await w.repo.getPendingByIds(batch.pendingIds)
  const g = (await w.repo.getGroup(groupId))!
  const tree = readTree(g.ratchetTree!)
  const skip = new Set(rejected.map((r) => r.pendingId))
  const refs = items.filter((p) => p.proposalRef && !skip.has(p.id)).map((p) => toB64(p.proposalRef!))
  const removed = items.filter((p) => p.op === 'remove' && !skip.has(p.id)).map((p) => p.leafIndex!)
  const byValue = items.filter((p) => p.op === 'add' && !p.proposalRef && !skip.has(p.id))
  const idx = freeLeaves(tree, removed, byValue.length)
  const body = await commitRequest(w, groupId, committer, { refs, adds: byValue.map((p, i) => ({ leafIndex: idx[i]!, keyPackage: toB64(p.keyPackage!) })), removes: [] }, { welcome: byValue.length > 0 || items.some((p) => p.op === 'add') })
  body.batchId = batch.id
  body.rejected = rejected
  return uploadCommit(w.repo, w.deps, out, { userId: committer.userId, device: committer }, groupId, body)
}

/** Runs the scheduler for the group and commits the batch that it assigns. */
export async function runBatchAndCommit(w: World, groupId: Uint8Array, out?: import('./events').Outbox) {
  const { Outbox } = await import('./events')
  const { scheduleGroup } = await import('./batches')
  const o = out ?? new Outbox()
  await scheduleGroup(w.repo, w.deps, o, groupId)
  return commitLiveBatch(w, o, groupId)
}

/** A commit upload from `committer` on the current state of the group. */
export async function commitRequest(
  w: Pick<World, 'repo' | 'ds'>,
  groupId: Uint8Array,
  committer: DeviceRow | null,
  rest: FakeCommitRest,
  opts: { welcome?: boolean; gi?: Partial<FakeGroupInfoRest>; nextTree?: FakeLeaf[] } = {},
) {
  const g = (await w.repo.getGroup(groupId))!
  const prev = readTree(g.ratchetTree!)
  const prevGi = readGroupInfo(g.groupInfo!)
  const senderLeaf = committer && !rest.external ? prev.find((l) => l.deviceId === committer.id)!.leafIndex : null
  return {
    epoch: g.epoch!,
    commit: fakeCommit(g.groupId, g.epoch!, senderLeaf, rest),
    groupInfo: fakeGroupInfo(g.groupId, g.epoch! + 1, g.cipherSuite, { signerLeaf: senderLeaf ?? 0, descriptor: rest.descriptor ?? prevGi.descriptor, ...opts.gi }),
    ratchetTree: fakeTree(opts.nextTree ?? transition(w.ds, prev, rest)),
    welcome: opts.welcome ? new Uint8Array(randomBytes(64)) : null,
    batchId: null as string | null,
    rejected: [] as { pendingId: string; reason: string }[],
  }
}
