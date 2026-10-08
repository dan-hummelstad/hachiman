import { describe, expect, it } from 'vitest'

import type { GroupDescriptor, MlsGroupHandle, ProposalPolicy } from '../api'
import { fromB64url } from '../codec'
import { ExporterLabel } from '../constants'
import { ds } from './ds'
import { contextOf, externalCommitAuth, messageSecret, mls, proposalRefOf } from './index'
import { decodePublicMessage, normalizeExternalSender } from './wire'
import { dsSigner, keyPackage, makeDevice, makeUser, policy, recertify, rotateDsk, uuid, type TestDevice, type TestUser } from './test-helpers'

const te = new TextEncoder()

async function newGroup(kind: 'channel' | 'public_set' | 'dm', creator: TestDevice, opts: { historyVisibility?: 'joined' | 'shared' } = {}) {
  const signer = await dsSigner()
  const guildId = uuid()
  const channelId = uuid()
  const descriptor: GroupDescriptor = {
    kind,
    guildId: kind === 'dm' ? null : guildId,
    channelId: kind === 'public_set' ? null : channelId,
    historyVisibility: opts.historyVisibility ?? (kind === 'public_set' ? 'shared' : 'joined'),
    createdByUserId: creator.user.userId,
  }
  const gid = mls.groupId({ kind, scope: kind === 'public_set' ? guildId : channelId, generation: 0 })
  const kp = await keyPackage(creator)
  const created = await mls.createGroup({ groupId: gid, descriptor, dsExternalSender: signer.externalSender, cipherSuite: 1, keyPackage: kp })
  return { signer, descriptor, gid, ...created }
}

async function addAndJoin(handle: MlsGroupHandle, joiner: TestDevice, p: ProposalPolicy) {
  const kp = await keyPackage(joiner)
  const pc = await mls.commit(handle, { adds: [kp.publicPackage], removes: [], descriptor: null, policy: p })
  const joined = await mls.joinFromWelcome({ welcome: fromB64url(pc.request.welcome!), ratchetTree: fromB64url(pc.request.ratchetTree), keyPackage: kp, policy: p })
  return { pc, joined }
}

async function apply(handle: MlsGroupHandle, message: Uint8Array, p: ProposalPolicy): Promise<MlsGroupHandle> {
  const r = await mls.processHandshake(handle, message, p)
  if (r.result === 'rejected') throw new Error(`rejected: ${r.reason}`)
  return r.handle
}

function users(...ds: TestDevice[]): TestUser[] {
  return [...new Set(ds.map((d) => d.user))]
}

describe('MlsModule', () => {
  it('encodes group ids and descriptors with the per-kind rules', () => {
    const scope = uuid()
    const id = mls.groupId({ kind: 'channel', scope, generation: 7 })
    expect(id).toHaveLength(22)
    expect(mls.parseGroupId(id)).toEqual({ kind: 'channel', scope, generation: 7 })
    const d: GroupDescriptor = { kind: 'voice', guildId: uuid(), channelId: null, historyVisibility: 'joined', createdByUserId: uuid() }
    expect(mls.decodeGroupDescriptor(mls.encodeGroupDescriptor(d))).toEqual(d)
    expect(() => mls.encodeGroupDescriptor({ ...d, channelId: uuid() })).toThrow()
    // A DM call: channel_id instead of guild_id, never neither.
    const dmCall: GroupDescriptor = { ...d, guildId: null, channelId: uuid() }
    expect(mls.decodeGroupDescriptor(mls.encodeGroupDescriptor(dmCall))).toEqual(dmCall)
    expect(() => mls.encodeGroupDescriptor({ ...d, guildId: null })).toThrow()
    expect(() => mls.encodeGroupDescriptor({ ...d, historyVisibility: 'shared' })).toThrow()
    expect(() => mls.encodeGroupDescriptor({ kind: 'dm', guildId: uuid(), channelId: uuid(), historyVisibility: 'joined', createdByUserId: uuid() })).toThrow()
    expect(() => mls.encodeGroupDescriptor({ kind: 'public_set', guildId: uuid(), channelId: uuid(), historyVisibility: 'shared', createdByUserId: uuid() })).toThrow()
    const bytes = mls.encodeGroupDescriptor({ kind: 'channel', guildId: uuid(), channelId: uuid(), historyVisibility: 'joined', createdByUserId: uuid() })
    expect(() => mls.decodeGroupDescriptor(new Uint8Array([...bytes, 0]))).toThrow()
  })

  it('creates a group with the three extensions in order, adds, removes by DS proposal and resyncs', async () => {
    const a = makeDevice(makeUser())
    const b = makeDevice(makeUser())
    const g = await newGroup('channel', a)
    const p = policy({ kind: 'channel', users: users(a, b), dsKey: g.signer.publicKey })
    const info = await ds.inspectGroupInfo(g.groupInfo, g.ratchetTree)
    expect(info.extensions.types).toEqual([5, 3, 0xf1a1])
    expect(info.signatureValid && info.treeHashValid).toBe(true)
    expect(info.descriptor).toEqual(g.descriptor)

    const { pc, joined } = await addAndJoin(g.handle, b, p)
    let ah = pc.next
    let bh = joined
    expect(pc.added.map((x) => x.deviceId)).toEqual([b.deviceId])
    expect(await messageSecret(bh)).toEqual(await messageSecret(ah))
    expect(mls.epochAuthenticator(bh)).toEqual(mls.epochAuthenticator(ah))
    expect(mls.roster(bh).map((x) => x.userId)).toEqual([a.user.userId, b.user.userId])

    // A DS Remove of b: both store it, a commits it by reference.
    const removeB = await ds.proposeRemove(g.signer, (await mls.groupInfo(ah)).groupInfo, 1)
    ah = await apply(ah, removeB, p)
    bh = await apply(bh, removeB, p)
    expect(mls.hasPendingRemoves(ah)).toBe(true)
    // The same Remove by value is dropped: one Remove in the commit.
    const rm = await mls.commit(ah, { adds: [], removes: [1], descriptor: null, policy: p })
    const content = decodePublicMessage(fromB64url(rm.request.commit)).content
    if (content.contentType !== 'commit') throw new Error('commit')
    expect(content.commit.proposals).toHaveLength(1)
    expect(content.commit.proposals[0]!.proposalOrRefType).toBe('reference')
    const r = await mls.processHandshake(bh, fromB64url(rm.request.commit), p)
    expect(r.result === 'applied' && r.selfRemoved).toBe(true)
    ah = rm.next
    expect(mls.hasPendingRemoves(ah)).toBe(false)
    expect(mls.roster(ah)).toHaveLength(1)

    // ts-mls cannot resync the only member (removeLeafNode condenses the tree to nothing).
    const solo = await mls.groupInfo(ah)
    await expect(mls.joinExternal({ groupInfo: solo.groupInfo, ratchetTree: solo.ratchetTree, keyPackage: await keyPackage(a), resync: true, policy: p })).rejects.toThrow()

    // Resync of a's own leaf by external commit (a new chain after a DSK rotation).
    const c = makeDevice(makeUser())
    const pc2 = policy({ kind: 'channel', users: users(a, c), dsKey: g.signer.publicKey })
    const { pc: addC, joined: ch } = await addAndJoin(ah, c, pc2)
    rotateDsk(a.user)
    const a2 = recertify(a)
    const kp = await keyPackage(a2)
    const gi = await mls.groupInfo(addC.next)
    const pAfter = policy({ kind: 'channel', users: users(a, c), dsKey: g.signer.publicKey })
    const resync = await mls.joinExternal({ groupInfo: gi.groupInfo, ratchetTree: gi.ratchetTree, keyPackage: kp, resync: true, policy: pAfter })
    expect(resync.next.ownLeaf).toBe(0)
    expect(mls.roster(resync.next)[0]!.chain!.dsk.generation).toBe(2)
    const ch2 = await apply(ch, fromB64url(resync.request.commit), pAfter)
    expect(mls.roster(ch2)[0]!.chain!.dsk.generation).toBe(2)
    expect(await messageSecret(ch2)).toEqual(await messageSecret(resync.next))
  }, 60_000)

  it('rejects a DS Add outside public_set, a bad chain, a non-reader Add and member proposals', async () => {
    const a = makeDevice(makeUser())
    const b = makeDevice(makeUser())
    const c = makeDevice(makeUser())
    const g = await newGroup('channel', a)
    const p = policy({ kind: 'channel', users: users(a, b), dsKey: g.signer.publicKey })
    const { pc, joined } = await addAndJoin(g.handle, b, p)

    // A DS Add proposal in a channel group. ds.proposeAdd refuses it, so build it with ts-mls directly.
    const { proposeExternal } = await import('ts-mls')
    const { decodeGroupInfoMessage, decodeKeyPackageMessage, encodePublic, suite } = await import('./wire')
    const cs = await suite(1)
    const ckp = await keyPackage(c)
    const gi = decodeGroupInfoMessage((await mls.groupInfo(pc.next)).groupInfo)
    const dsAdd = await proposeExternal(gi, { proposalType: 'add', add: { keyPackage: decodeKeyPackageMessage(ckp.publicPackage) } }, g.signer.publicKey, g.signer.privateKey, cs)
    if (dsAdd.wireformat !== 'mls_public_message') throw new Error('pm')
    const pAll = policy({ kind: 'channel', users: users(a, b, c), dsKey: g.signer.publicKey })
    expect(await mls.processHandshake(joined, encodePublic(dsAdd.publicMessage), pAll)).toEqual({ result: 'rejected', reason: 'ds_add_outside_public_set' })

    // A non-reader Add by value.
    const pNotReader = policy({ kind: 'channel', users: users(a, b, c), dsKey: g.signer.publicKey, readers: [a.user.userId, b.user.userId] })
    await expect(mls.commit(pc.next, { adds: [ckp.publicPackage], removes: [], descriptor: null, policy: pNotReader })).rejects.toThrow(/not_reader/)
    // ... and a member that sees such a commit rejects it.
    const sneaky = await mls.commit(pc.next, { adds: [ckp.publicPackage], removes: [], descriptor: null, policy: pAll })
    expect(await mls.processHandshake(joined, fromB64url(sneaky.request.commit), pNotReader)).toMatchObject({ result: 'rejected', reason: 'not_reader' })

    // A bad chain: the certificate is signed by an unknown DSK.
    const forged = makeDevice({ ...c.user, dsk: { ...c.user.dsk, keyPair: makeUser().dsk.keyPair } })
    const fkp = await keyPackage(forged)
    await expect(mls.commit(pc.next, { adds: [fkp.publicPackage], removes: [], descriptor: null, policy: pAll })).rejects.toThrow(/invalid_chain/)

    // An admin-reader check (Phase 4): the joiner is a reader per REST, not per the signed chain.
    const pAdmin = policy({ kind: 'channel', users: users(a, b, c), dsKey: g.signer.publicKey, adminReaders: [a.user.userId, b.user.userId] })
    await expect(mls.commit(pc.next, { adds: [ckp.publicPackage], removes: [], descriptor: null, policy: pAdmin })).rejects.toThrow(/not_admin_reader/)

    // A member proposal (members cannot reference their own proposals) is rejected.
    const { createProposal, decodeGroupState } = await import('ts-mls')
    const { clientConfig } = await import('./index')
    const bState = { ...decodeGroupState(joined.state, 0)![0], clientConfig }
    const memberRemove = await createProposal(bState, true, { proposalType: 'remove', remove: { removed: 0 } }, cs)
    if (memberRemove.message.wireformat !== 'mls_public_message') throw new Error('pm')
    expect(await mls.processHandshake(pc.next, encodePublic(memberRemove.message.publicMessage), p)).toEqual({ result: 'rejected', reason: 'member_proposal' })

    // A Remove by value of another reader is illegal.
    await expect(mls.commit(pc.next, { adds: [], removes: [1], descriptor: null, policy: p })).rejects.toThrow(/illegal_remove/)
    // A revoked device may be removed.
    const pRev = policy({ kind: 'channel', users: users(a, b), dsKey: g.signer.publicKey, revoked: [b.deviceId] })
    const ok = await mls.commit(pc.next, { adds: [], removes: [1], descriptor: null, policy: pRev })
    expect(ok.removed.map((x) => x.deviceId)).toEqual([b.deviceId])
  }, 60_000)

  it('applies the GCE rules: history_visibility only, and only with permission', async () => {
    const a = makeDevice(makeUser())
    const b = makeDevice(makeUser())
    const g = await newGroup('channel', a)
    const deny = policy({ kind: 'channel', users: users(a, b), dsKey: g.signer.publicKey })
    const allow = policy({ kind: 'channel', users: users(a, b), dsKey: g.signer.publicKey, canChangeDescriptor: (u) => u === a.user.userId })
    const { pc, joined } = await addAndJoin(g.handle, b, deny)
    await expect(mls.commit(pc.next, { adds: [], removes: [], descriptor: { ...g.descriptor, historyVisibility: 'shared' }, policy: deny })).rejects.toThrow(/gce_permission/)
    await expect(mls.commit(pc.next, { adds: [], removes: [], descriptor: { ...g.descriptor, kind: 'public_set', channelId: null }, policy: allow })).rejects.toThrow()
    await expect(mls.commit(pc.next, { adds: [], removes: [], descriptor: { ...g.descriptor, createdByUserId: b.user.userId }, policy: allow })).rejects.toThrow(/gce_descriptor_fields/)
    const gce = await mls.commit(pc.next, { adds: [], removes: [], descriptor: { ...g.descriptor, historyVisibility: 'shared' }, policy: allow })
    expect(await mls.processHandshake(joined, fromB64url(gce.request.commit), deny)).toMatchObject({ result: 'rejected', reason: 'gce_permission' })
    const applied = await apply(joined, fromB64url(gce.request.commit), allow)
    expect(contextOf(applied).descriptor?.historyVisibility).toBe('shared')

    // A GCE that changes external_senders is rejected by members, even with permission.
    const { createCommit } = await import('ts-mls')
    const { suite } = await import('./wire')
    const other = await dsSigner()
    const st = (await import('ts-mls')).decodeGroupState(pc.next.state, 0)![0]
    const { clientConfig } = await import('./index')
    const exts = st.groupContext.extensions.map((e) => (e.extensionType === 'external_senders' ? { ...e, extensionData: other.externalSender } : e))
    const bad = await createCommit({ state: { ...st, clientConfig }, cipherSuite: await suite(1) }, { wireAsPublicMessage: true, extraProposals: [{ proposalType: 'group_context_extensions', groupContextExtensions: { extensions: exts } }] })
    if (bad.commit.wireformat !== 'mls_public_message') throw new Error('pm')
    const { encodePublic } = await import('./wire')
    expect(await mls.processHandshake(joined, encodePublic(bad.commit.publicMessage), allow)).toMatchObject({ result: 'rejected', reason: 'gce_external_senders' })
  }, 60_000)

  it('runs a public_set group with DS Adds, and an external join of a reader', async () => {
    const a = makeDevice(makeUser())
    const b = makeDevice(makeUser())
    const c = makeDevice(makeUser())
    const g = await newGroup('public_set', a)
    const p = policy({ kind: 'public_set', users: users(a, b, c), dsKey: g.signer.publicKey })
    const bkp = await keyPackage(b)
    const add = await ds.proposeAdd(g.signer, g.groupInfo, bkp.publicPackage)
    const ah = await apply(g.handle, add, p)
    const pc = await mls.commit(ah, { adds: [], removes: [], descriptor: null, policy: p })
    expect(pc.added.map((x) => x.deviceId)).toEqual([b.deviceId])
    const bh = await mls.joinFromWelcome({ welcome: fromB64url(pc.request.welcome!), ratchetTree: fromB64url(pc.request.ratchetTree), keyPackage: bkp, policy: p })
    // An external join of a reader (no member online).
    const gi = await mls.groupInfo(bh)
    const ckp = await keyPackage(c)
    const ext = await mls.joinExternal({ groupInfo: gi.groupInfo, ratchetTree: gi.ratchetTree, keyPackage: ckp, resync: false, policy: p })
    const bh2 = await apply(bh, fromB64url(ext.request.commit), p)
    expect(await messageSecret(bh2)).toEqual(await messageSecret(ext.next))
    // A non-reader may not join by external commit.
    const d = makeDevice(makeUser())
    const ext2 = await mls.joinExternal({ groupInfo: (await mls.groupInfo(bh2)).groupInfo, ratchetTree: (await mls.groupInfo(bh2)).ratchetTree, keyPackage: await keyPackage(d), resync: false, policy: policy({ kind: 'public_set', users: users(a, b, c, d), dsKey: g.signer.publicKey }) })
    expect(await mls.processHandshake(bh2, fromB64url(ext2.request.commit), policy({ kind: 'public_set', users: users(a, b, c, d), dsKey: g.signer.publicKey, readers: [a.user.userId, b.user.userId, c.user.userId] }))).toMatchObject({ result: 'rejected', reason: 'not_reader' })
  }, 60_000)

  it('rejects an external join into a channel group by a user without a leaf, and allows an own new device', async () => {
    const a = makeDevice(makeUser())
    const a2 = makeDevice(a.user)
    const m = makeDevice(makeUser())
    const g = await newGroup('channel', a)
    const p = policy({ kind: 'channel', users: users(a, m), dsKey: g.signer.publicKey })
    const ext = await mls.joinExternal({ groupInfo: g.groupInfo, ratchetTree: g.ratchetTree, keyPackage: await keyPackage(m), resync: false, policy: p })
    expect(await mls.processHandshake(g.handle, fromB64url(ext.request.commit), p)).toMatchObject({ result: 'rejected', reason: 'external_join_without_leaf' })
    const own = await mls.joinExternal({ groupInfo: g.groupInfo, ratchetTree: g.ratchetTree, keyPackage: await keyPackage(a2), resync: false, policy: p })
    expect((await mls.processHandshake(g.handle, fromB64url(own.request.commit), p)).result).toBe('applied')
  }, 60_000)

  it('accepts an external join of a user without a leaf into a channel group only for the leaf key of an accepted InviteAuth (§12.11.4)', async () => {
    const a = makeDevice(makeUser())
    const m = makeDevice(makeUser())
    const g = await newGroup('channel', a)
    const p = policy({ kind: 'channel', users: users(a, m), dsKey: g.signer.publicKey })
    const auth = te.encode('an InviteAuth')
    const ext = await mls.joinExternal({ groupInfo: g.groupInfo, ratchetTree: g.ratchetTree, keyPackage: await keyPackage(m), resync: false, policy: p, authenticatedData: auth })
    const commit = fromB64url(ext.request.commit)
    expect(externalCommitAuth(commit)).toEqual({ authenticatedData: auth, leafSignatureKey: m.sig.publicKey })
    const plain = await mls.joinExternal({ groupInfo: g.groupInfo, ratchetTree: g.ratchetTree, keyPackage: await keyPackage(m), resync: false, policy: p })
    expect(externalCommitAuth(fromB64url(plain.request.commit))).toBeNull()
    expect(externalCommitAuth(g.groupInfo)).toBeNull()

    // No key, or the key of another leaf: the old rule.
    expect(await mls.processHandshake(g.handle, commit, p)).toMatchObject({ result: 'rejected', reason: 'external_join_without_leaf' })
    expect(await mls.processHandshake(g.handle, commit, { ...p, inviteJoinKey: makeDevice(m.user).sig.publicKey })).toMatchObject({ result: 'rejected', reason: 'external_join_without_leaf' })
    // The key, but the user does not read the channel (REST readers, or the admin chain).
    const notReader = policy({ kind: 'channel', users: users(a, m), dsKey: g.signer.publicKey, readers: [a.user.userId] })
    expect(await mls.processHandshake(g.handle, commit, { ...notReader, inviteJoinKey: m.sig.publicKey })).toMatchObject({ result: 'rejected', reason: 'not_reader' })
    const notAdminReader = policy({ kind: 'channel', users: users(a, m), dsKey: g.signer.publicKey, adminReaders: [a.user.userId] })
    expect(await mls.processHandshake(g.handle, commit, { ...notAdminReader, inviteJoinKey: m.sig.publicKey })).toMatchObject({ result: 'rejected', reason: 'not_admin_reader' })
    // The key of the new leaf, and a reader: applied.
    const ok = await mls.processHandshake(g.handle, commit, { ...p, inviteJoinKey: m.sig.publicKey })
    expect(ok.result).toBe('applied')
    if (ok.result === 'applied') expect(await messageSecret(ok.handle)).toEqual(await messageSecret(ext.next))

    // A dm group never takes it.
    const dm = await newGroup('dm', a)
    const pd = policy({ kind: 'dm', users: users(a, m), dsKey: dm.signer.publicKey })
    const dmExt = await mls.joinExternal({ groupInfo: dm.groupInfo, ratchetTree: dm.ratchetTree, keyPackage: await keyPackage(m), resync: false, policy: pd, authenticatedData: auth })
    expect(await mls.processHandshake(dm.handle, fromB64url(dmExt.request.commit), { ...pd, inviteJoinKey: m.sig.publicKey })).toMatchObject({ result: 'rejected', reason: 'external_join_without_leaf' })
  }, 60_000)

  it('rejects every DS proposal and external commit in a voice group', async () => {
    const a = makeDevice(makeUser())
    const b = makeDevice(makeUser())
    const guildId = uuid()
    const room = uuid()
    const descriptor: GroupDescriptor = { kind: 'voice', guildId, channelId: null, historyVisibility: 'joined', createdByUserId: a.user.userId }
    const gid = mls.groupId({ kind: 'voice', scope: room, generation: 0 })
    await expect(mls.createGroup({ groupId: gid, descriptor, dsExternalSender: (await dsSigner()).externalSender, cipherSuite: 1, keyPackage: await keyPackage(a) })).rejects.toThrow()
    const created = await mls.createGroup({ groupId: gid, descriptor, dsExternalSender: null, cipherSuite: 1, keyPackage: await keyPackage(a) })
    const info = await ds.inspectGroupInfo(created.groupInfo, created.ratchetTree)
    expect(info.extensions.types).toEqual([3, 0xf1a1])
    expect(info.extensions.externalSenders).toBeNull()
    const bkp = await keyPackage(b)
    const ids = (d: TestDevice) => `${d.user.userId}:${d.deviceId}`
    const notPending = policy({ kind: 'voice', users: users(a, b), dsKey: null, voice: { pending: new Set(), departedDeviceIds: new Set() } })
    await expect(mls.commit(created.handle, { adds: [bkp.publicPackage], removes: [], descriptor: null, policy: notPending })).rejects.toThrow(/not_pending/)
    const pv = policy({ kind: 'voice', users: users(a, b), dsKey: null, voice: { pending: new Set([ids(b)]), departedDeviceIds: new Set() } })
    const pc = await mls.commit(created.handle, { adds: [bkp.publicPackage], removes: [], descriptor: null, policy: pv })
    const bh = await mls.joinFromWelcome({ welcome: fromB64url(pc.request.welcome!), ratchetTree: fromB64url(pc.request.ratchetTree), keyPackage: bkp, policy: pv })
    expect(await mls.exporter(bh, ExporterLabel.SFRAME, new Uint8Array(), 32)).toEqual(await mls.exporter(pc.next, ExporterLabel.SFRAME, new Uint8Array(), 32))

    // A DS-style proposal (a forged external sender) is rejected.
    const { proposeExternal } = await import('ts-mls')
    const { decodeGroupInfoMessage, encodePublic, suite } = await import('./wire')
    const signer = await dsSigner()
    const gi = decodeGroupInfoMessage((await mls.groupInfo(pc.next)).groupInfo)
    const forgedGi = { ...gi, groupContext: { ...gi.groupContext, extensions: [{ extensionType: 'external_senders' as const, extensionData: signer.externalSender }, ...gi.groupContext.extensions] } }
    const prop = await proposeExternal(forgedGi, { proposalType: 'remove', remove: { removed: 0 } }, signer.publicKey, signer.privateKey, await suite(1))
    if (prop.wireformat !== 'mls_public_message') throw new Error('pm')
    expect((await mls.processHandshake(bh, encodePublic(prop.publicMessage), pv)).result).toBe('rejected')
    // A Remove by value needs a departed device.
    await expect(mls.commit(bh, { adds: [], removes: [0], descriptor: null, policy: pv })).rejects.toThrow(/remove_not_departed/)
    // External commits are refused.
    const g2 = await mls.groupInfo(pc.next)
    await expect(mls.joinExternal({ groupInfo: g2.groupInfo, ratchetTree: g2.ratchetTree, keyPackage: await keyPackage(makeDevice(makeUser())), resync: false, policy: pv })).rejects.toThrow()
  }, 60_000)

  it('restores state from bytes and compares GroupInfo for the fork check', async () => {
    const a = makeDevice(makeUser())
    const b = makeDevice(makeUser())
    const g = await newGroup('dm', a)
    const p = policy({ kind: 'dm', users: users(a, b), dsKey: g.signer.publicKey })
    const { pc, joined } = await addAndJoin(g.handle, b, p)
    const restored = await mls.restore(joined.state)
    expect(restored.epoch).toBe(1)
    expect(await messageSecret(restored)).toEqual(await messageSecret(pc.next))
    expect(mls.matchesGroupInfo(restored, fromB64url(pc.request.groupInfo))).toBe(true)
    expect(mls.matchesGroupInfo(restored, g.groupInfo)).toBe(false)
    // A restored state can still commit.
    const upd = await mls.commit(restored, { adds: [], removes: [], descriptor: null, policy: p })
    expect((await mls.processHandshake(pc.next, fromB64url(upd.request.commit), p)).result).toBe('applied')
  }, 60_000)

  it('seals and opens history bundles, and checks the sender', async () => {
    const a = makeDevice(makeUser())
    const b = makeDevice(makeUser())
    const g = await newGroup('channel', a, { historyVisibility: 'shared' })
    const p = policy({ kind: 'channel', users: users(a, b), dsKey: g.signer.publicKey })
    const s0 = await messageSecret(g.handle)
    const { pc, joined } = await addAndJoin(g.handle, b, p)
    const entries = [{ groupId: g.gid, epoch: 0, secret: s0 }]
    const bundle = await mls.sealHistoryBundle(pc.next, a.sig.privateKey, a.deviceId, entries)
    expect(await mls.openHistoryBundle(joined, bundle, p)).toEqual(entries)
    // A tampered byte fails.
    const bad = bundle.slice()
    bad[bad.length - 1]! ^= 1
    await expect(mls.openHistoryBundle(joined, bad, p)).rejects.toThrow()
    // The sender leaf must be the sender device, and the key must be its leaf key.
    await expect(mls.sealHistoryBundle(pc.next, b.sig.privateKey, a.deviceId, entries)).rejects.toThrow()
    await expect(mls.sealHistoryBundle(pc.next, a.sig.privateKey, b.deviceId, entries)).rejects.toThrow()
    // A bundle of another epoch does not open.
    const upd = await mls.commit(pc.next, { adds: [], removes: [], descriptor: null, policy: p })
    const later = await apply(joined, fromB64url(upd.request.commit), p)
    await expect(mls.openHistoryBundle(later, bundle, p)).rejects.toThrow(/another epoch/)
  }, 60_000)

  it('computes the same proposal ref on the client and the DS', async () => {
    const a = makeDevice(makeUser())
    const g = await newGroup('channel', a)
    const msg = await ds.proposeRemove(g.signer, g.groupInfo, 0)
    expect(await proposalRefOf(msg, 1)).toEqual(await ds.proposalRef(msg, 1))
    expect(normalizeExternalSender(g.signer.publicKey).encoded).toEqual(g.signer.externalSender)
    expect(te.encode('x')).toHaveLength(1)
  }, 30_000)
})
