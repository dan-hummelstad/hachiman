/**
 * DS group creation and commit upload (docs/gateway-protocol.md §12.7.3,
 * §12.7.7) on the in-memory repo with the FakeDs of testing.ts.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Permissions } from '@hachiman/client/permissions'

import { ApiError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'

import { toB64 } from './bytes'
import { commitCheckError, uploadCommit } from './commits'
import { Outbox } from './events'
import { createGroup } from './groups'
import { uploadKeyPackages } from './key-packages'
import { flushWithProposals, onMembershipChangeWith } from './membership'
import type { DeviceRow, GroupRow } from './repo'
import {
  activate,
  activeDevice,
  commitLiveBatch,
  commitRequest,
  createRequest,
  fakeKeyPackage,
  leafOf,
  newWorld,
  readTree,
  type World,
} from './testing'
import { runSchedulerTick } from './batches'

setBusPublisher(async () => undefined)

async function rejects(p: Promise<unknown>, code: string, status?: number): Promise<ApiError> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof ApiError, `expected ApiError ${code}, got ${String(err)}`)
    assert.equal(err.code, code, err.message)
    if (status !== undefined) assert.equal(err.status, status)
    return err
  }
  assert.fail(`expected ${code}`)
}

/** A DM of alice and bob with an active group where only alice has a leaf. */
async function dm(w: World) {
  const alice = w.repo.addUser()
  const bob = w.repo.addUser()
  const aDev = await activeDevice(w, alice)
  const bDev = await activeDevice(w, bob)
  await uploadKeyPackages(w.repo, w.deps, bDev, { cipherSuite: 1, keyPackages: [fakeKeyPackage(bDev), fakeKeyPackage(bDev)], lastResort: null })
  const channelId = w.repo.addDm([alice, bob])
  const out = new Outbox()
  await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId }, aDev.id))
  const pending = (await w.repo.listGroupsByChannel(channelId))[0]!
  return { alice, bob, aDev, bDev, channelId, pending, out }
}

async function dmActive(w: World) {
  const d = await dm(w)
  const group = await activate(w, d.out, d.pending, d.aDev)
  return { ...d, group }
}

/** A guild with one private text channel (VIEW for role `staff` only). */
async function privateChannel(w: World) {
  const owner = w.repo.addUser()
  const guildId = w.repo.addGuild(owner, undefined, Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES)
  const staff = w.repo.addRole(guildId, 0)
  const carol = w.repo.addUser()
  const eve = w.repo.addUser()
  w.repo.addGuildMember(guildId, carol, [staff])
  w.repo.addGuildMember(guildId, eve, [])
  const channelId = w.repo.addChannel({ guildId, type: 'text' })
  w.repo.setOverwrites(channelId, [
    { id: guildId, type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL },
    { id: staff, type: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 },
  ])
  const oDev = await activeDevice(w, owner)
  const cDev = await activeDevice(w, carol)
  const eDev = await activeDevice(w, eve)
  for (const d of [cDev, eDev]) await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 1, keyPackages: [fakeKeyPackage(d)], lastResort: fakeKeyPackage(d) })
  const out = new Outbox()
  await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'channel_created', channelId }, oDev.id))
  const pending = (await w.repo.listGroupsByChannel(channelId)).find((g) => g.kind === 'channel')!
  const group = await activate(w, out, pending, oDev)
  return { owner, carol, eve, guildId, staff, channelId, oDev, cDev, eDev, group, out }
}

describe('POST /mls/groups (§12.7.7)', () => {
  test('dm_created allocates a pending group and assigns the create to the requesting device', async () => {
    const w = await newWorld()
    const { pending, aDev, out } = await dm(w)
    assert.equal(pending.status, 'pending')
    assert.equal(pending.cipherSuite, 1)
    const assign = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(assign.channel, `device:${aDev.id}`)
    assert.equal((assign.d as { create: { cipherSuite: number } }).create.cipherSuite, 1)
  })

  test('rejections: assignee, extensions, descriptor, leaves, signature, exists', async () => {
    const w = await newWorld()
    const { pending, aDev, bDev, out } = await dm(w)
    const batch = (await w.repo.listBatchesOfGroup(pending.groupId))[0]!
    const caller = { userId: aDev.userId, device: aDev }
    const create = (req: ReturnType<typeof createRequest>, who = caller) => createGroup(w.repo, w.deps, out, who, req)

    await rejects(create(createRequest(w, pending, bDev, batch.id), { userId: bDev.userId, device: bDev }), 'IllegalAdd', 403)
    await rejects(create(createRequest(w, pending, aDev, batch.id, { extensions: { types: [3, 5, 0xf1a1], externalSenders: toB64(w.deps.signer.externalSender), requiredCapabilities: null } })), 'InvalidCommit', 400)
    await rejects(create(createRequest(w, pending, aDev, batch.id, { extensions: { types: [5, 3, 0xf1a1], externalSenders: toB64(new Uint8Array(8)), requiredCapabilities: null } })), 'InvalidCommit', 400)
    await rejects(create(createRequest(w, pending, aDev, batch.id, { descriptor: { kind: 'dm', guildId: null, channelId: pending.channelId, historyVisibility: 'joined', createdByUserId: bDev.userId } })), 'InvalidCommit', 400)
    await rejects(create(createRequest(w, pending, aDev, batch.id, { descriptor: { kind: 'dm', guildId: null, channelId: pending.channelId, historyVisibility: 'shared', createdByUserId: aDev.userId } })), 'InvalidCommit', 400)
    await rejects(create(createRequest(w, pending, aDev, batch.id, {}, [leafOf(aDev, 0), leafOf(bDev, 1)])), 'IllegalAdd', 403)
    await rejects(create(createRequest(w, pending, aDev, batch.id, { signatureValid: false })), 'InvalidCommit', 400)
    await rejects(create({ ...createRequest(w, pending, aDev, batch.id), cipherSuite: 83 }), 'InvalidCommit', 400)

    const ok = await create(createRequest(w, pending, aDev, batch.id))
    assert.equal(ok.status, 'active')
    assert.equal(ok.epoch, 0)
    assert.equal(ok.member, true)
    await rejects(create(createRequest(w, pending, aDev, batch.id)), 'GroupExists', 409)
  })

  test('the create queues Adds by value for the other reader devices', async () => {
    const w = await newWorld()
    const { group, bDev } = await dmActive(w)
    const pending = await w.repo.listPending(group.groupId, ['queued'])
    assert.equal(pending.length, 1)
    assert.equal(pending[0]!.op, 'add')
    assert.equal(pending[0]!.deviceId, bDev.id)
    assert.equal(pending[0]!.proposal, null, 'an Add by value has no DS proposal')
  })
})

describe('POST /mls/groups/:id/commits (§12.7.3)', () => {
  test('a batch commit adds by value, writes the Welcome and settles the item', async () => {
    const w = await newWorld()
    const { group, bDev, alice, bob } = await dmActive(w)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const assign = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal((assign.d as { joins: unknown[] }).joins.length, 1)
    const res = await commitLiveBatch(w, out, group.groupId)
    assert.deepEqual(res, { epoch: 1, seq: 1 })
    const roster = await w.repo.listMembers(group.groupId)
    assert.deepEqual(roster.map((m) => m.deviceId), [group && (await w.repo.listMembers(group.groupId))[0]!.deviceId, bDev.id])
    const inbox = await w.repo.listInbox(bDev.id, 0, 10, new Date(w.clock.now))
    assert.equal(inbox.length, 1)
    assert.equal(inbox[0]!.kind, 'welcome')
    assert.equal((await w.repo.listPending(group.groupId, ['queued', 'assigned'])).length, 0)
    assert.equal((await w.repo.listBatchesOfGroup(group.groupId)).length, 0)
    const hs = out.events.filter((e) => e.t === 'MLS_HANDSHAKE')
    // One commit, sent to user:{p} of each DM participant.
    assert.deepEqual(hs.map((e) => e.channel).sort(), [`user:${alice}`, `user:${bob}`].sort())
    assert.ok(out.events.some((e) => e.t === 'DEVICE_INBOX' && e.channel === `device:${bDev.id}`))
  })

  test('concurrent commits on one epoch: exactly one wins, the other gets 409 with the epoch', async () => {
    const w = await newWorld()
    const { group, aDev, bDev } = await dmActive(w)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    await commitLiveBatch(w, out, group.groupId)
    const a = await commitRequest(w, group.groupId, aDev, { refs: [], adds: [], removes: [] })
    const b = await commitRequest(w, group.groupId, bDev, { refs: [], adds: [], removes: [] })
    const results = await Promise.allSettled([
      uploadCommit(w.repo, w.deps, out, { userId: aDev.userId, device: aDev }, group.groupId, a),
      uploadCommit(w.repo, w.deps, out, { userId: bDev.userId, device: bDev }, group.groupId, b),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    assert.equal(won.length, 1)
    assert.equal(lost.length, 1)
    const err = lost[0]!.reason as ApiError
    assert.equal(err.code, 'EpochConflict')
    assert.equal(err.status, 409)
    assert.deepEqual(err.extra, { epoch: 2 })
  })

  test('a commit for an old epoch gets 409 EpochConflict before any other check', async () => {
    const w = await newWorld()
    const { group, aDev } = await dmActive(w)
    const body = await commitRequest(w, group.groupId, aDev, { refs: [], adds: [], removes: [] })
    const err = await rejects(uploadCommit(w.repo, w.deps, new Outbox(), { userId: aDev.userId, device: aDev }, group.groupId, { ...body, epoch: 5 }), 'EpochConflict', 409)
    assert.deepEqual(err.extra, { epoch: 0 })
  })

  test('checkCommit failures map to codes', async () => {
    assert.equal(commitCheckError('roster transition mismatch').code, 'InvalidCommit')
    assert.equal(commitCheckError('roster transition mismatch').status, 400)
    assert.equal(commitCheckError('leaf 2: invalid chain').code, 'IllegalAdd')
    assert.equal(commitCheckError('leaf 2: invalid chain').status, 403)

    const w = await newWorld()
    const { group, aDev, bDev } = await dmActive(w)
    const caller = { userId: aDev.userId, device: aDev }
    // A tree that hides an Add: the commit adds bob, the tree does not show him.
    const kp = fakeKeyPackage(bDev)
    const hidden = await commitRequest(w, group.groupId, aDev, { refs: [], adds: [{ leafIndex: 1, keyPackage: toB64(kp) }], removes: [] }, { welcome: true, nextTree: [leafOf(aDev, 0)] })
    const e1 = await rejects(uploadCommit(w.repo, w.deps, new Outbox(), caller, group.groupId, hidden), 'InvalidCommit', 400)
    assert.match(e1.message, /roster transition/)
    // A new leaf whose chain does not verify (check 7).
    const badChain = await commitRequest(w, group.groupId, aDev, { refs: [], adds: [{ leafIndex: 1, keyPackage: toB64(kp) }], removes: [] }, {
      welcome: true,
      nextTree: [leafOf(aDev, 0), { ...leafOf(bDev, 1), chainValid: false }],
    })
    await rejects(uploadCommit(w.repo, w.deps, new Outbox(), caller, group.groupId, badChain), 'IllegalAdd', 403)
    // Bob reads the DM (check 1 passes) but the commit's sender leaf is Alice's (check 3).
    const sender = await commitRequest(w, group.groupId, aDev, { refs: [], adds: [], removes: [] })
    const e3 = await rejects(uploadCommit(w.repo, w.deps, new Outbox(), { userId: bDev.userId, device: bDev }, group.groupId, sender), 'InvalidCommit', 400)
    assert.match(e3.message, /sender/)
    const noPub = await commitRequest(w, group.groupId, aDev, { refs: [], adds: [], removes: [] }, { gi: { externalPub: false } })
    await rejects(uploadCommit(w.repo, w.deps, new Outbox(), caller, group.groupId, noPub), 'InvalidCommit', 400)
  })

  test('an unpublished proposal ref is rejected', async () => {
    const w = await newWorld()
    const { group, aDev } = await dmActive(w)
    // A Remove that the DS signed but never stored as pending: no member may reference it.
    const msg = await w.ds.proposeRemove(w.deps.signer, group.groupInfo!, 0)
    const ref = toB64(await w.ds.proposalRef(msg))
    const body = await commitRequest(w, group.groupId, aDev, { refs: [ref], adds: [], removes: [] })
    const err = await rejects(uploadCommit(w.repo, w.deps, new Outbox(), { userId: aDev.userId, device: aDev }, group.groupId, body), 'InvalidCommit', 400)
    assert.match(err.message, /unpublished/)
    assert.equal(w.ds.checks.at(-1)!.publishedProposals.length, 0)
  })

  test('IllegalMembership: an Add of a user without VIEW_CHANNEL', async () => {
    const w = await newWorld()
    const { group, oDev, eDev, eve } = await privateChannel(w)
    const kp = fakeKeyPackage(eDev)
    const body = await commitRequest(w, group.groupId, oDev, { refs: [], adds: [{ leafIndex: 1, keyPackage: toB64(kp) }], removes: [] }, { welcome: true })
    const err = await rejects(uploadCommit(w.repo, w.deps, new Outbox(), { userId: oDev.userId, device: oDev }, group.groupId, body), 'IllegalMembership', 403)
    assert.deepEqual(err.extra, { userIds: [eve] })
  })

  test('IllegalRemove: a member removes another reader by value', async () => {
    const w = await newWorld()
    const { group, cDev, oDev } = await privateChannel(w)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    await commitLiveBatch(w, out, group.groupId)
    const body = await commitRequest(w, group.groupId, cDev, { refs: [], adds: [], removes: [0] })
    await rejects(uploadCommit(w.repo, w.deps, out, { userId: cDev.userId, device: cDev }, group.groupId, body), 'IllegalRemove', 403)
    void oDev
  })

  test('external commit: channel groups need a user that already has a leaf', async () => {
    const w = await newWorld()
    const { group, cDev, carol } = await privateChannel(w)
    const leaf = { ...leafOf(cDev, 1) }
    const body = await commitRequest(w, group.groupId, null, { refs: [], adds: [], removes: [], external: { leaf, resyncOf: null } })
    await rejects(uploadCommit(w.repo, w.deps, new Outbox(), { userId: carol, device: cDev }, group.groupId, body), 'IllegalAdd', 403)
  })

  test('a GCE needs MANAGE_CHANNELS, and only history_visibility may change', async () => {
    const w = await newWorld()
    const { group, cDev, oDev } = await privateChannel(w)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    await commitLiveBatch(w, out, group.groupId)
    const g = (await w.repo.getGroup(group.groupId))!
    const descriptor = { kind: 'channel' as const, guildId: g.guildId, channelId: g.channelId, historyVisibility: 'shared' as const, createdByUserId: oDev.userId }
    const byCarol = await commitRequest(w, g.groupId, cDev, { refs: [], adds: [], removes: [], descriptor })
    await rejects(uploadCommit(w.repo, w.deps, out, { userId: cDev.userId, device: cDev }, g.groupId, byCarol), 'MissingPermissions', 403)
    const moved = await commitRequest(w, g.groupId, oDev, { refs: [], adds: [], removes: [], descriptor: { ...descriptor, channelId: g.guildId } })
    await rejects(uploadCommit(w.repo, w.deps, out, { userId: oDev.userId, device: oDev }, g.groupId, moved), 'InvalidCommit', 400)
    const byOwner = await commitRequest(w, g.groupId, oDev, { refs: [], adds: [], removes: [], descriptor })
    await uploadCommit(w.repo, w.deps, out, { userId: oDev.userId, device: oDev }, g.groupId, byOwner)
    assert.equal((await w.repo.getGroup(g.groupId))!.historyVisibility, 'shared')
    assert.ok(out.events.some((e) => e.t === 'MLS_GROUP_UPDATE'))
  })

  test('orphan leaves after a user delete stay only while their Remove is queued', async () => {
    const w = await newWorld()
    const { group, cDev, oDev, carol } = await privateChannel(w)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    await commitLiveBatch(w, out, group.groupId)
    const carolLeaf = (await w.repo.memberByDevice(group.groupId, cDev.id))!.leafIndex

    // user_deleted runs before the delete and queues the Removes keyed by leaf index.
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'user_deleted', userId: carol }, null))
    w.repo.deleteUser(carol)
    const orphan = (await w.repo.listMembers(group.groupId)).find((m) => m.leafIndex === carolLeaf)!
    assert.equal(orphan.deviceId, null)
    assert.equal(orphan.userId, null)
    const removes = await w.repo.listPending(group.groupId, ['queued'])
    assert.equal(removes.length, 1)
    assert.equal(removes[0]!.leafIndex, carolLeaf)

    // An unrelated commit keeps the orphan leaf: accepted, because its Remove is queued.
    await flushWithProposals(w.repo, out, w.deps)
    const keep = await commitRequest(w, group.groupId, oDev, { refs: [], adds: [], removes: [] })
    await uploadCommit(w.repo, w.deps, out, { userId: oDev.userId, device: oDev }, group.groupId, keep)

    // Without the queued Remove, the same commit fails.
    const [pendingRemove] = await w.repo.listPending(group.groupId, ['queued', 'assigned'])
    await w.repo.updatePending(pendingRemove!.id, { status: 'rejected' })
    const again = await commitRequest(w, group.groupId, oDev, { refs: [], adds: [], removes: [] })
    await rejects(uploadCommit(w.repo, w.deps, out, { userId: oDev.userId, device: oDev }, group.groupId, again), 'IllegalMembership', 403)
    await w.repo.updatePending(pendingRemove!.id, { status: 'queued' })

    // The Remove commit (by reference) clears the orphan and the pending item.
    await runSchedulerTick(w.repo, w.deps, out)
    await commitLiveBatch(w, out, group.groupId)
    assert.equal((await w.repo.listMembers(group.groupId)).some((m) => m.leafIndex === carolLeaf), false)
    assert.equal((await w.repo.listPending(group.groupId, ['queued', 'assigned'])).length, 0)
    const tree = readTree((await w.repo.getGroup(group.groupId))!.ratchetTree!)
    assert.equal(tree.some((l) => l.leafIndex === carolLeaf), false)
  })
})

export type { DeviceRow, GroupRow }
