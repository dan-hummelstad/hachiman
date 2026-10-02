import { createCommit, decodeGroupState, encodeMlsMessage } from 'ts-mls'
import { describe, expect, it } from 'vitest'

import type { GroupDescriptor, MlsGroupHandle, ProposalPolicy, UserId } from '../api'
import { fromB64url, toB64url } from '../codec'
import { ds } from './ds'
import { clientConfig, mls } from './index'
import { dsSigner, keyPackage, makeDevice, makeUser, policy, uuid, type TestDevice, type TestUser } from './test-helpers'
import { decodeGroupInfoMessage, decodeKeyPackageMessage, encodePublic, suite } from './wire'

interface World {
  signer: Awaited<ReturnType<typeof dsSigner>>
  a: TestDevice
  b: TestDevice
  c: TestDevice
  p: ProposalPolicy
  /** a and b are members at epoch 1. */
  ah: MlsGroupHandle
  bh: MlsGroupHandle
  stored: { groupInfo: Uint8Array; ratchetTree: Uint8Array }
  masterKeys: (u: UserId) => Uint8Array | null
}

async function world(kind: 'channel' | 'public_set' = 'channel'): Promise<World> {
  const signer = await dsSigner()
  const a = makeDevice(makeUser())
  const b = makeDevice(makeUser())
  const c = makeDevice(makeUser())
  const users: TestUser[] = [a.user, b.user, c.user]
  const p = policy({ kind, users, dsKey: signer.publicKey })
  const guildId = uuid()
  const channelId = uuid()
  const descriptor: GroupDescriptor = { kind, guildId, channelId: kind === 'channel' ? channelId : null, historyVisibility: 'joined', createdByUserId: a.user.userId }
  const gid = mls.groupId({ kind, scope: kind === 'channel' ? channelId : guildId, generation: 0 })
  const created = await mls.createGroup({ groupId: gid, descriptor, dsExternalSender: signer.externalSender, cipherSuite: 1, keyPackage: await keyPackage(a) })
  const bkp = await keyPackage(b)
  const pc = await mls.commit(created.handle, { adds: [bkp.publicPackage], removes: [], descriptor: null, policy: p })
  const bh = await mls.joinFromWelcome({ welcome: fromB64url(pc.request.welcome!), ratchetTree: fromB64url(pc.request.ratchetTree), keyPackage: bkp, policy: p })
  const masters = new Map(users.map((u) => [u.userId, u.master.record.publicKey]))
  return { signer, a, b, c, p, ah: pc.next, bh, stored: await mls.groupInfo(pc.next), masterKeys: (u) => masters.get(u) ?? null }
}

function input(w: World, req: { commit: string; groupInfo: string; ratchetTree: string }, sender: TestDevice, extra: Partial<Parameters<typeof ds.checkCommit>[0]> = {}) {
  return {
    groupId: w.ah.groupId,
    epoch: w.ah.epoch,
    commit: fromB64url(req.commit),
    groupInfo: fromB64url(req.groupInfo),
    ratchetTree: fromB64url(req.ratchetTree),
    previous: w.stored,
    sender: { userId: sender.user.userId, deviceId: sender.deviceId },
    publishedProposalRefs: [],
    masterKeys: w.masterKeys,
    ...extra,
  }
}

describe('DsModule.checkCommit', () => {
  it('accepts an Add by value and reports the transition', async () => {
    const w = await world()
    const ckp = await keyPackage(w.c)
    const pc = await mls.commit(w.ah, { adds: [ckp.publicPackage], removes: [], descriptor: null, policy: w.p })
    const r = await ds.checkCommit(input(w, pc.request, w.a))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.inspection.sender).toEqual({ type: 'member', leafIndex: 0 })
    expect(r.inspection.proposalTypes).toEqual(['add'])
    expect(r.inspection.changedLeaves).toEqual([2])
    expect(r.inspection.removedLeaves).toEqual([])
    expect(r.inspection.next.epoch).toBe(2)
    expect(r.inspection.next.roster.map((x) => x.deviceId)).toEqual([w.a.deviceId, w.b.deviceId, w.c.deviceId])
    expect(r.inspection.next.hasExternalPub).toBe(true)
    expect(r.inspection.descriptorChanged).toBe(false)
  }, 60_000)

  it('rejects a wrong epoch, a bad tree hash, a wrong signer and a sender that is not the request device', async () => {
    const w = await world()
    const pc = await mls.commit(w.ah, { adds: [(await keyPackage(w.c)).publicPackage], removes: [], descriptor: null, policy: w.p })
    expect(await ds.checkCommit({ ...input(w, pc.request, w.a), epoch: 2 })).toMatchObject({ ok: false, reason: 'epoch' })
    // A tree that is not the tree of the GroupInfo.
    expect(await ds.checkCommit({ ...input(w, pc.request, w.a), ratchetTree: w.stored.ratchetTree })).toMatchObject({ ok: false, reason: 'group_info: tree hash' })
    // The request device is b, but a committed.
    expect(await ds.checkCommit(input(w, pc.request, w.b))).toMatchObject({ ok: false, reason: 'sender: credential is not the request device' })
    // A GroupInfo signed by another member (b signs a GroupInfo of its own epoch-1 view).
    const bInfo = await mls.groupInfo(w.bh)
    const forged = decodeGroupInfoMessage(fromB64url(pc.request.groupInfo))
    const signedByB = decodeGroupInfoMessage(bInfo.groupInfo)
    const swapped = encodeMlsMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo: { ...forged, signer: 1, signature: signedByB.signature } })
    const r = await ds.checkCommit({ ...input(w, pc.request, w.a), groupInfo: swapped })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.reason).toMatch(/group_info: (signature|the signer)/)
  }, 60_000)

  it('rejects a missing external_pub', async () => {
    const w = await world()
    const pc = await mls.commit(w.ah, { adds: [], removes: [], descriptor: null, policy: w.p })
    const gi = decodeGroupInfoMessage(fromB64url(pc.request.groupInfo))
    const stripped = encodeMlsMessage({ version: 'mls10', wireformat: 'mls_group_info', groupInfo: { ...gi, extensions: gi.extensions.filter((e) => e.extensionType !== 'external_pub') } })
    expect(await ds.checkCommit({ ...input(w, pc.request, w.a), groupInfo: stripped })).toMatchObject({ ok: false, reason: 'group_info: external_pub missing' })
  }, 60_000)

  it('rejects a bad chain in a new leaf', async () => {
    const w = await world()
    // The certificate is signed by a DSK that the user's master key never certified.
    const rogue = makeDevice({ ...w.c.user, dsk: { ...w.c.user.dsk, keyPair: makeUser().dsk.keyPair } })
    const kp = decodeKeyPackageMessage((await keyPackage(rogue)).publicPackage)
    const st = { ...decodeGroupState(w.ah.state, 0)![0], clientConfig }
    const r = await createCommit({ state: st, cipherSuite: await suite(1) }, { wireAsPublicMessage: true, extraProposals: [{ proposalType: 'add', add: { keyPackage: kp } }] })
    if (r.commit.wireformat !== 'mls_public_message') throw new Error('pm')
    const next = await mls.restore(new Uint8Array((await import('ts-mls')).encodeGroupState(r.newState)))
    const gi = await mls.groupInfo(next)
    const res = await ds.checkCommit(input(w, { commit: toB64url(encodePublic(r.commit.publicMessage)), groupInfo: toB64url(gi.groupInfo), ratchetTree: toB64url(gi.ratchetTree) }, w.a))
    expect(res).toMatchObject({ ok: false, reason: 'leaf 2: chain:bad_signature' })
  }, 60_000)

  it('accepts DS Removes by reference only when Takusen published them, with refs or full messages', async () => {
    const w = await world()
    const remove = await ds.proposeRemove(w.signer, w.stored.groupInfo, 1)
    const ref = await ds.proposalRef(remove, 1)
    const r = await mls.processHandshake(w.ah, remove, w.p)
    if (r.result !== 'proposal_stored') throw new Error(r.result)
    const pc = await mls.commit(r.handle, { adds: [], removes: [], descriptor: null, policy: w.p })
    expect(await ds.checkCommit(input(w, pc.request, w.a))).toMatchObject({ ok: false, reason: 'proposal_ref: not a published DS proposal' })
    for (const published of [[ref], [remove]]) {
      const ok = await ds.checkCommit(input(w, pc.request, w.a, { publishedProposalRefs: published }))
      expect(ok.ok).toBe(true)
      if (ok.ok) {
        expect(ok.inspection.removedLeaves).toEqual([1])
        expect(ok.inspection.proposalRefs).toEqual([ref])
      }
    }
  }, 60_000)

  it('infers the transition of public_set DS Adds and Removes from refs alone', async () => {
    const w = await world('public_set')
    const add = await ds.proposeAdd(w.signer, w.stored.groupInfo, (await keyPackage(w.c)).publicPackage)
    const remove = await ds.proposeRemove(w.signer, w.stored.groupInfo, 1)
    let h = w.ah
    for (const m of [add, remove]) {
      const r = await mls.processHandshake(h, m, w.p)
      if (r.result !== 'proposal_stored') throw new Error(r.result)
      h = r.handle
    }
    const pc = await mls.commit(h, { adds: [], removes: [], descriptor: null, policy: w.p })
    const refs = [await ds.proposalRef(add, 1), await ds.proposalRef(remove, 1)]
    const ok = await ds.checkCommit(input(w, pc.request, w.a, { publishedProposalRefs: refs }))
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.inspection.removedLeaves).toEqual([1])
      expect(ok.inspection.changedLeaves).toEqual([0, 1])
      expect(ok.inspection.next.roster.map((x) => x.deviceId)).toEqual([w.a.deviceId, w.c.deviceId])
    }
    // Only one of the two refs published: rejected.
    expect((await ds.checkCommit(input(w, pc.request, w.a, { publishedProposalRefs: refs.slice(0, 1) }))).ok).toBe(false)
  }, 60_000)

  it('rejects a tree that hides an Add', async () => {
    const w = await world()
    const ckp = await keyPackage(w.c)
    const withAdd = await mls.commit(w.ah, { adds: [ckp.publicPackage], removes: [], descriptor: null, policy: w.p })
    const plain = await mls.commit(w.ah, { adds: [], removes: [], descriptor: null, policy: w.p })
    // The commit adds c, but the uploaded GroupInfo and tree are from a commit without it.
    const res = await ds.checkCommit(input(w, { commit: withAdd.request.commit, groupInfo: plain.request.groupInfo, ratchetTree: plain.request.ratchetTree }, w.a))
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.reason).toMatch(/transcript|roster/)
  }, 60_000)

  it('checks external commits: a resync of the own leaf and a join', async () => {
    const w = await world('public_set')
    const gi = await mls.groupInfo(w.bh)
    const own = await mls.joinExternal({ groupInfo: gi.groupInfo, ratchetTree: gi.ratchetTree, keyPackage: await keyPackage(w.b), resync: true, policy: w.p })
    const ok = await ds.checkCommit(input(w, own.request, w.b))
    expect(ok.ok && ok.inspection.sender.type).toBe('new_member_commit')
    if (ok.ok) {
      expect(ok.inspection.changedLeaves).toEqual([1])
      expect(ok.inspection.removedLeaves).toEqual([])
    }
    const join = await mls.joinExternal({ groupInfo: gi.groupInfo, ratchetTree: gi.ratchetTree, keyPackage: await keyPackage(w.c), resync: false, policy: w.p })
    const j = await ds.checkCommit(input(w, join.request, w.c))
    expect(j.ok && j.inspection.changedLeaves).toEqual([2])
    expect(await ds.checkCommit(input(w, join.request, w.a))).toMatchObject({ ok: false, reason: 'sender: credential is not the request device' })
  }, 60_000)
})

describe('DsModule helpers', () => {
  it('inspects a GroupInfo: extensions, descriptor, signature and tree hash', async () => {
    const w = await world()
    const info = await ds.inspectGroupInfo(w.stored.groupInfo, w.stored.ratchetTree)
    expect(info.epoch).toBe(1)
    expect(info.cipherSuite).toBe(1)
    expect(info.signatureValid).toBe(true)
    expect(info.treeHashValid).toBe(true)
    expect(info.extensions.types).toEqual([5, 3, 0xf1a1])
    expect(info.extensions.externalSenders).toEqual(w.signer.externalSender)
    expect(info.descriptor?.kind).toBe('channel')
    expect(info.roster.map((x) => x.deviceId)).toEqual([w.a.deviceId, w.b.deviceId])
    expect((await ds.rosterOf(w.stored.groupInfo, w.stored.ratchetTree)).length).toBe(2)
    const other = await world()
    expect((await ds.inspectGroupInfo(w.stored.groupInfo, other.stored.ratchetTree)).treeHashValid).toBe(false)
  }, 60_000)

  it('inspects key packages and refuses DS Adds outside public_set', async () => {
    const w = await world()
    const kp = await keyPackage(w.c)
    const i = await ds.inspectKeyPackage(kp.publicPackage)
    expect(i).toMatchObject({ userId: w.c.user.userId, deviceId: w.c.deviceId, cipherSuite: 1, signatureValid: true })
    expect(i.ref).toEqual(kp.ref)
    expect(i.chain?.device.deviceId).toBe(w.c.deviceId)
    expect(i.notAfterMs).toBeGreaterThan(Date.now())
    await expect(ds.proposeAdd(w.signer, w.stored.groupInfo, kp.publicPackage)).rejects.toThrow(/public_set/)
  }, 60_000)

  it('verifies key objects', async () => {
    const { identity } = await import('../identity/index')
    const u = makeUser()
    const d = makeDevice(u)
    const master = identity.encodeMasterKeyRecord(u.master.record)
    const dsk = identity.encodeDskCert(u.dsk.cert)
    const cert = identity.encodeDeviceCertificate(d.chain.device)
    expect(ds.verifyMasterKeyRecord(master, null)?.userId).toBe(u.userId)
    expect(ds.verifyDskCert(dsk, master)?.generation).toBe(1)
    expect(ds.verifyDeviceCertificate(cert, dsk, master)?.deviceId).toBe(d.deviceId)
    expect(ds.verifyDeviceCertificate(cert, identity.encodeDskCert(makeUser().dsk.cert), master)).toBeNull()
    const rev = identity.revoke(u.master, d.deviceId, 1, Date.now())
    expect(ds.verifyRevocation(identity.encodeRevocation(rev), { master, deviceCertificate: null })?.deviceId).toBe(d.deviceId)
    const out = identity.signOut({ userId: u.userId, deviceId: d.deviceId, masterGeneration: 1, mlsSignatureKey: d.sig }, Date.now())
    expect(ds.verifyRevocation(identity.encodeRevocation(out), { master, deviceCertificate: cert })?.reason).toBe(5)
    expect(ds.verifyRevocation(identity.encodeRevocation(out), { master, deviceCertificate: null })).toBeNull()
  })
})
