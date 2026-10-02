/**
 * DS proposals, the batch scheduler, join requests and key packages
 * (docs/gateway-protocol.md §12.7.2, §12.7.4, §12.7.5, §12.7.8).
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Permissions } from '@hachiman/client/permissions'

import { ApiError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'

import { declineBatch, runSchedulerTick, scheduleGroup } from './batches'
import { toB64 } from './bytes'
import { uploadCommit } from './commits'
import { Outbox } from './events'
import { postJoinRequest } from './joins'
import { countKeyPackages, uploadKeyPackages } from './key-packages'
import { flushWithProposals, onMembershipChangeWith } from './membership'
import { signPendingProposals } from './proposals'
import type { DeviceRow } from './repo'
import { commitRequestSchema, splitRejections } from './schemas'
import { activate, activeDevice, commitLiveBatch, commitRequest, fakeKeyPackage, leafOf, newWorld, runBatchAndCommit, type World } from './testing'

setBusPublisher(async () => undefined)

async function rejects(p: Promise<unknown>, code: string): Promise<ApiError> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err))
    assert.equal(err.code, code, err.message)
    return err
  }
  assert.fail(`expected ${code}`)
}

/** A guild whose public channel uses the public_set group, with `n` member users. */
async function publicGuild(w: World, n: number, opts: { online?: boolean } = {}) {
  const owner = w.repo.addUser()
  const guildId = w.repo.addGuild(owner, undefined, Permissions.VIEW_CHANNEL | Permissions.SEND_MESSAGES)
  const channelId = w.repo.addChannel({ guildId, type: 'text' })
  const oDev = await activeDevice(w, owner)
  const members: { userId: string; device: DeviceRow }[] = []
  for (let i = 0; i < n; i++) {
    const userId = w.repo.addUser()
    w.repo.addGuildMember(guildId, userId)
    const device = await activeDevice(w, userId, opts)
    members.push({ userId, device })
  }
  const out = new Outbox()
  await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'guild_created', guildId }, oDev.id))
  const pending = (await w.repo.listGroupsByGuild(guildId)).find((g) => g.kind === 'public_set')!
  const group = await activate(w, out, pending, oDev)
  return { owner, guildId, channelId, oDev, members, group }
}

async function join(w: World, groupId: Uint8Array, m: { userId: string; device: DeviceRow }, out = new Outbox()) {
  const jr = await postJoinRequest(w.repo, w.deps, out, m, groupId, fakeKeyPackage(m.device))
  await flushWithProposals(w.repo, out, w.deps)
  return jr
}

describe('DS proposals (§12.7.4)', () => {
  test('a public_set Add is signed once per epoch and is in the handshake stream before the batch', async () => {
    const w = await newWorld()
    const { group, members } = await publicGuild(w, 1)
    const out = new Outbox()
    const jr = await join(w, group.groupId, members[0]!, out)
    assert.equal(jr.status, 'queued')
    const [item] = await w.repo.listPending(group.groupId, ['queued'])
    assert.equal(item!.op, 'add')
    assert.equal(item!.proposalEpoch, 0)
    const hs = await w.repo.listHandshakes(group.groupId, 0, 10)
    assert.equal(hs.length, 1)
    assert.equal(hs[0]!.kind, 'proposal')
    assert.deepEqual(hs[0]!.message, item!.proposal)

    // A second signing pass for the same epoch signs nothing.
    await signPendingProposals(w.repo, w.deps, out, group.groupId)
    assert.equal((await w.repo.listHandshakes(group.groupId, 0, 10)).length, 1)

    // The batch lists exactly the stored bytes, and they came first in the stream.
    const sched = new Outbox()
    await scheduleGroup(w.repo, w.deps, sched, group.groupId)
    const assign = sched.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!.d as { proposals: string[]; joins: unknown[] }
    assert.deepEqual(assign.proposals, [toB64(item!.proposal!)])
    assert.deepEqual(assign.joins, [], 'public_set Adds are proposals, not joins')

    const res = await commitLiveBatch(w, sched, group.groupId)
    assert.equal(res.epoch, 1)
    assert.ok(await w.repo.memberByDevice(group.groupId, members[0]!.device.id))
    assert.equal((await w.repo.getJoinRequest(jr.id))!.status, 'committed')
  })

  test('checkCommit gets the signed proposals, so a commit cannot reference an Add and hide it', async () => {
    const w = await newWorld()
    const { group, members, oDev } = await publicGuild(w, 1)
    await join(w, group.groupId, members[0]!)
    const [item] = await w.repo.listPending(group.groupId, ['queued'])
    const ref = toB64(item!.proposalRef!)
    const caller = { userId: oDev.userId, device: oDev }
    const g = (await w.repo.getGroup(group.groupId))!
    const hidden = await commitRequest(w, group.groupId, oDev, { refs: [ref], adds: [], removes: [] }, { welcome: true, nextTree: [leafOf(oDev, 0)] })
    const err = await rejects(uploadCommit(w.repo, w.deps, new Outbox(), caller, group.groupId, hidden), 'InvalidCommit')
    assert.match(err.message, /roster transition/)
    assert.deepEqual(w.ds.checks.at(-1)!.publishedProposals, [item!.proposal], 'the stored MLSMessage, not the ref')
    assert.equal((await w.repo.getGroup(group.groupId))!.epoch, g.epoch)
  })

  test('a Remove is signed once per epoch, appended before the batch, and signed again after an epoch change', async () => {
    const w = await newWorld()
    const { group, members, guildId } = await publicGuild(w, 3)
    for (const m of members) await join(w, group.groupId, m)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    await commitLiveBatch(w, out, group.groupId)
    const before = (await w.repo.getGroup(group.groupId))!
    assert.equal(before.epoch, 1)

    // Kick member 2: a Remove is queued and wakes the scheduler.
    const kicked = members[2]!
    w.repo.removeGuildMember(guildId, kicked.userId)
    const change = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, change, { kind: 'guild_member_removed', guildId, userId: kicked.userId }, null))
    assert.ok(change.wake.has(toB64(group.groupId)), 'a Remove wakes the scheduler')
    await flushWithProposals(w.repo, change, w.deps)
    const [rm] = await w.repo.listPending(group.groupId, ['queued'])
    assert.equal(rm!.op, 'remove')
    assert.equal(rm!.proposalEpoch, 1)
    const firstProposal = rm!.proposal!
    const seqAfterSign = (await w.repo.getGroup(group.groupId))!.latestSeq

    // An unrelated commit (member 0 rotates nothing) moves the epoch while the Remove waits.
    // The kicked user is a non-reader, but the leaf may stay because its Remove is queued.
    const m0 = members[0]!.device
    const body = await commitRequest(w, group.groupId, m0, { refs: [], adds: [], removes: [] })
    const res = await uploadCommit(w.repo, w.deps, out, { userId: m0.userId, device: m0 }, group.groupId, body)
    assert.equal(res.epoch, 2)
    const [rm2] = await w.repo.listPending(group.groupId, ['queued'])
    assert.equal(rm2!.proposalEpoch, 2)
    assert.notDeepEqual(rm2!.proposal, firstProposal)
    const stream = await w.repo.listHandshakes(group.groupId, seqAfterSign, 10)
    assert.deepEqual(stream.map((h) => h.kind), ['commit', 'proposal'], 'the new proposal follows the commit')

    // The batch takes the new bytes and the commit removes the leaf.
    const sched = new Outbox()
    await scheduleGroup(w.repo, w.deps, sched, group.groupId)
    const assign = sched.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.deepEqual((assign.d as { proposals: string[] }).proposals, [toB64(rm2!.proposal!)])
    assert.notEqual(assign.channel, `device:${kicked.device.id}`, 'a device that the batch removes never commits it')
    await commitLiveBatch(w, sched, group.groupId)
    assert.equal(await w.repo.memberByDevice(group.groupId, kicked.device.id), null)
  })
})

describe('batch scheduler (§12.7.5)', () => {
  test('one commit clears the batch; the committer is the online member with the lowest leaf', async () => {
    const w = await newWorld()
    const { group, members, oDev } = await publicGuild(w, 2)
    for (const m of members) await join(w, group.groupId, m)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const assign = out.events.filter((e) => e.t === 'MLS_BATCH_ASSIGN')
    assert.equal(assign.length, 1)
    assert.equal(assign[0]!.channel, `device:${oDev.id}`)
    assert.equal((assign[0]!.d as { proposals: string[] }).proposals.length, 2)
    await commitLiveBatch(w, out, group.groupId)
    assert.equal((await w.repo.listPending(group.groupId, ['queued', 'assigned'])).length, 0)
    assert.equal((await w.repo.listMembers(group.groupId)).length, 3)
  })

  test('a timeout fails over to the next online device; a decline skips the wait', async () => {
    const w = await newWorld()
    const { group, members, oDev } = await publicGuild(w, 3)
    await join(w, group.groupId, members[0]!)
    await join(w, group.groupId, members[1]!)
    let out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    await commitLiveBatch(w, out, group.groupId)

    await join(w, group.groupId, members[2]!)
    out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const first = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(first.channel, `device:${oDev.id}`)

    // The deadline passes: the next device (lowest leaf after the owner) gets the batch.
    w.clock.now += w.config.batchTimeoutMs + 1
    out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const second = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(second.channel, `device:${members[0]!.device.id}`)

    // That device declines: the batch goes on at once.
    const batchId = (second.d as { batchId: string }).batchId
    out = new Outbox()
    await declineBatch(w.repo, w.deps, out, members[0]!.device.id, batchId)
    const third = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(third.channel, `device:${members[1]!.device.id}`)
    await rejects(declineBatch(w.repo, w.deps, out, members[0]!.device.id, batchId), 'BatchExpired')
    await rejects(declineBatch(w.repo, w.deps, out, members[2]!.device.id, (third.d as { batchId: string }).batchId), 'UnknownBatch')

    await commitLiveBatch(w, out, group.groupId)
    assert.ok(await w.repo.memberByDevice(group.groupId, members[2]!.device.id))
  })

  test('a decline with rejectedProposals rejects the DS Add by ref; the next batch leaves it out', async () => {
    const w = await newWorld()
    const { group, members, oDev } = await publicGuild(w, 3)
    const bad = members[0]!
    const good = members[1]!
    // members[2] joins first, so the batch can fail over to it.
    await join(w, group.groupId, members[2]!)
    await runBatchAndCommit(w, group.groupId)
    const jrBad = await join(w, group.groupId, bad)
    await join(w, group.groupId, good)
    const pending = await w.repo.listPending(group.groupId, ['queued'])
    const badRow = pending.find((p) => p.deviceId === bad.device.id)!
    const goodRow = pending.find((p) => p.deviceId === good.device.id)!

    let out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const first = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(first.channel, `device:${oDev.id}`)
    const batchId = (first.d as { batchId: string }).batchId
    const report = [{ proposalRef: badRow.proposalRef!, reason: 'invalid_chain' }]

    // Only the assigned committer may report.
    await rejects(declineBatch(w.repo, w.deps, new Outbox(), members[2]!.device.id, batchId, report), 'UnknownBatch')
    assert.notEqual((await w.repo.getPendingByIds([badRow.id]))[0]!.status, 'rejected')

    out = new Outbox()
    await declineBatch(w.repo, w.deps, out, oDev.id, batchId, report)
    const [row] = await w.repo.getPendingByIds([badRow.id])
    assert.equal(row!.status, 'rejected')
    assert.equal(row!.reason, 'invalid_chain')
    assert.equal((await w.repo.getJoinRequest(jrBad.id))!.status, 'rejected')
    const update = out.events.find((e) => e.t === 'MLS_JOIN_UPDATE' && e.channel === `device:${bad.device.id}`)
    assert.deepEqual(update?.d, { requestId: jrBad.id, groupId: toB64(group.groupId), status: 'rejected', reason: 'invalid_chain' })
    const next = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(next.channel, `device:${members[2]!.device.id}`)
    assert.deepEqual((next.d as { proposals: string[] }).proposals, [toB64(goodRow.proposal!)], 'the rejected Add is not in the next batch')

    await commitLiveBatch(w, out, group.groupId)
    assert.ok(await w.repo.memberByDevice(group.groupId, good.device.id))
    assert.equal(await w.repo.memberByDevice(group.groupId, bad.device.id), null)
  })

  test('a commit with rejectedProposals settles the applied Adds and rejects the refused one', async () => {
    const w = await newWorld()
    const { group, members, oDev } = await publicGuild(w, 2)
    const [bad, good] = [members[0]!, members[1]!]
    const jrBad = await join(w, group.groupId, bad)
    await join(w, group.groupId, good)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const assign = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    const pending = await w.repo.listPending(group.groupId, ['assigned', 'queued'])
    const badRow = pending.find((p) => p.deviceId === bad.device.id)!
    const goodRow = pending.find((p) => p.deviceId === good.device.id)!

    const body = await commitRequest(w, group.groupId, oDev, { refs: [toB64(goodRow.proposalRef!)], adds: [], removes: [] }, { welcome: true })
    body.batchId = (assign.d as { batchId: string }).batchId
    const withReport = { ...body, rejectedProposals: [{ proposalRef: badRow.proposalRef!, reason: 'malformed' }] }
    const res = await uploadCommit(w.repo, w.deps, out, { userId: oDev.userId, device: oDev }, group.groupId, withReport)
    assert.equal(res.epoch, 1)
    assert.ok(await w.repo.memberByDevice(group.groupId, good.device.id))
    assert.equal((await w.repo.getPendingByIds([badRow.id]))[0]!.status, 'rejected')
    assert.equal((await w.repo.getJoinRequest(jrBad.id))!.status, 'rejected')
    assert.equal((await w.repo.listPending(group.groupId, ['queued', 'assigned'])).length, 0, 'nothing is left for the next batch')
  })

  test('a commit whose rejected[] names a DS Add by proposalRef (BatchRejection) rejects it in the commit transaction', async () => {
    const w = await newWorld()
    const { group, members, oDev } = await publicGuild(w, 2)
    const [bad, good] = [members[0]!, members[1]!]
    const jrBad = await join(w, group.groupId, bad)
    await join(w, group.groupId, good)
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const assign = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    const pending = await w.repo.listPending(group.groupId, ['assigned', 'queued'])
    const badRow = pending.find((p) => p.deviceId === bad.device.id)!
    const goodRow = pending.find((p) => p.deviceId === good.device.id)!

    const body = await commitRequest(w, group.groupId, oDev, { refs: [toB64(goodRow.proposalRef!)], adds: [], removes: [] }, { welcome: true })
    body.batchId = (assign.d as { batchId: string }).batchId
    const wire = commitRequestSchema.parse({
      epoch: body.epoch,
      commit: toB64(body.commit),
      groupInfo: toB64(body.groupInfo),
      ratchetTree: toB64(body.ratchetTree),
      welcome: body.welcome ? toB64(body.welcome) : null,
      batchId: body.batchId,
      rejected: [{ proposalRef: toB64(badRow.proposalRef!), reason: 'malformed' }],
    })
    const res = await uploadCommit(w.repo, w.deps, out, { userId: oDev.userId, device: oDev }, group.groupId, { ...wire, ...splitRejections(wire) })
    assert.equal(res.epoch, 1)
    assert.ok(await w.repo.memberByDevice(group.groupId, good.device.id))
    assert.equal((await w.repo.getPendingByIds([badRow.id]))[0]!.status, 'rejected')
    assert.equal((await w.repo.getJoinRequest(jrBad.id))!.status, 'rejected')
  })

  test('no online member: public_set joiners get external_commit, dm Adds get waiting', async () => {
    const w = await newWorld()
    const { group, members, oDev } = await publicGuild(w, 1)
    w.presence.online.delete(oDev.id)
    const out = new Outbox()
    const jr = await join(w, group.groupId, members[0]!, out)
    const sched = new Outbox()
    await runSchedulerTick(w.repo, w.deps, sched)
    assert.equal((await w.repo.getJoinRequest(jr.id))!.status, 'external_commit')
    const upd = sched.events.find((e) => e.t === 'MLS_JOIN_UPDATE')!
    assert.equal(upd.channel, `device:${members[0]!.device.id}`)
    assert.equal(sched.events.some((e) => e.t === 'MLS_BATCH_ASSIGN'), false)

    // The joiner adds itself by external commit. That settles its pending Add.
    const m = members[0]!
    const ext = await commitRequest(w, group.groupId, null, { refs: [], adds: [], removes: [], external: { leaf: leafOf(m.device, 1), resyncOf: null } })
    await uploadCommit(w.repo, w.deps, sched, m, group.groupId, ext)
    assert.equal((await w.repo.getJoinRequest(jr.id))!.status, 'committed')
    assert.equal((await w.repo.listPending(group.groupId, ['queued', 'assigned'])).length, 0)

    // dm: a new device of a participant waits for a member.
    const alice = w.repo.addUser()
    const bob = w.repo.addUser()
    const aDev = await activeDevice(w, alice)
    const bDev = await activeDevice(w, bob)
    const dm = w.repo.addDm([alice, bob])
    const o2 = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, o2, { kind: 'dm_created', channelId: dm }, aDev.id))
    const dmGroup = await activate(w, o2, (await w.repo.listGroupsByChannel(dm))[0]!, aDev)
    w.presence.online.delete(aDev.id)
    const bjr = await join(w, dmGroup.groupId, { userId: bob, device: bDev })
    await runSchedulerTick(w.repo, w.deps, new Outbox())
    assert.equal((await w.repo.getJoinRequest(bjr.id))!.status, 'waiting')
  })
})

describe('committer rejections are checked (§12.7.5)', () => {
  /** A public_set group where the owner and `members[2]` have leaves, and members[0..1] have open Adds. */
  async function setup() {
    const w = await newWorld()
    const g = await publicGuild(w, 3)
    await join(w, g.group.groupId, g.members[2]!)
    await runBatchAndCommit(w, g.group.groupId)
    const jr0 = await join(w, g.group.groupId, g.members[0]!)
    await join(w, g.group.groupId, g.members[1]!)
    const pending = await w.repo.listPending(g.group.groupId, ['queued'])
    const row0 = pending.find((p) => p.deviceId === g.members[0]!.device.id)!
    const row1 = pending.find((p) => p.deviceId === g.members[1]!.device.id)!
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const assign = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(assign.channel, `device:${g.oDev.id}`)
    return { w, ...g, jr0, row0, row1, batchId: (assign.d as { batchId: string }).batchId }
  }

  test('a false not_reader in a commit keeps the Add, gives a strike, and the next batch goes to the next committer', async () => {
    const { w, group, members, oDev, jr0, row0, row1, batchId } = await setup()
    const body = await commitRequest(w, group.groupId, oDev, { refs: [toB64(row1.proposalRef!)], adds: [], removes: [] }, { welcome: true })
    body.batchId = batchId
    const out = new Outbox()
    await uploadCommit(w.repo, w.deps, out, { userId: oDev.userId, device: oDev }, group.groupId, {
      ...body,
      rejectedProposals: [{ proposalRef: row0.proposalRef!, reason: 'not_reader' }],
    })
    assert.equal((await w.repo.getPendingByIds([row0.id]))[0]!.status, 'queued')
    assert.notEqual((await w.repo.getJoinRequest(jr0.id))!.status, 'rejected')
    assert.equal(out.events.some((e) => e.t === 'MLS_JOIN_UPDATE' && e.channel === `device:${members[0]!.device.id}` && (e.d as { status: string }).status === 'rejected'), false)
    assert.equal(w.strikes.counts.get(oDev.id), 1)

    const next = new Outbox()
    await runSchedulerTick(w.repo, w.deps, next)
    const assign = next.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.notEqual(assign.channel, `device:${oDev.id}`, 'the false reporter is in cooldown')
    await commitLiveBatch(w, next, group.groupId)
    assert.ok(await w.repo.memberByDevice(group.groupId, members[0]!.device.id))
  })

  test('a true not_reader is applied and gives no strike', async () => {
    const { w, group, members, oDev, jr0, row0, row1, batchId } = await setup()
    // Takusen sees the user leave the guild before it reconciles the group.
    w.repo.removeGuildMember(group.guildId!, members[0]!.userId)
    const body = await commitRequest(w, group.groupId, oDev, { refs: [toB64(row1.proposalRef!)], adds: [], removes: [] }, { welcome: true })
    body.batchId = batchId
    await uploadCommit(w.repo, w.deps, new Outbox(), { userId: oDev.userId, device: oDev }, group.groupId, {
      ...body,
      rejectedProposals: [{ proposalRef: row0.proposalRef!, reason: 'not_reader' }],
    })
    const [row] = await w.repo.getPendingByIds([row0.id])
    assert.equal(row!.status, 'rejected')
    assert.equal(row!.reason, 'not_reader')
    assert.equal((await w.repo.getJoinRequest(jr0.id))!.status, 'rejected')
    assert.equal(w.strikes.counts.get(oDev.id), undefined)
  })

  test('a false not_reader in a decline keeps the Add and the batch goes to the next device', async () => {
    const { w, members, oDev, row0, batchId } = await setup()
    const out = new Outbox()
    await declineBatch(w.repo, w.deps, out, oDev.id, batchId, [{ proposalRef: row0.proposalRef!, reason: 'not_reader' }])
    assert.notEqual((await w.repo.getPendingByIds([row0.id]))[0]!.status, 'rejected')
    assert.equal(w.strikes.counts.get(oDev.id), 1)
    const next = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(next.channel, `device:${members[2]!.device.id}`)
    const [kept] = await w.repo.getPendingByIds([row0.id])
    assert.ok((next.d as { proposals: string[] }).proposals.includes(toB64(kept!.proposal!)), 'the next batch has the kept Add')
  })

  test('a device with FALSE_REJECTION_LIMIT strikes gets no batch, also after its cooldown', async () => {
    const { w, members, oDev, row0, batchId } = await setup()
    w.strikes.counts.set(oDev.id, 2)
    await declineBatch(w.repo, w.deps, new Outbox(), oDev.id, batchId, [{ proposalRef: row0.proposalRef!, reason: 'not_reader' }])
    assert.equal(w.strikes.counts.get(oDev.id), 3)
    // The cooldown and the batch deadline pass: the scheduler still skips the device.
    w.clock.now += 120_000
    const out = new Outbox()
    await runSchedulerTick(w.repo, w.deps, out)
    const assign = out.events.find((e) => e.t === 'MLS_BATCH_ASSIGN')!
    assert.equal(assign.channel, `device:${members[2]!.device.id}`)
  })
})

describe('join requests (§12.7.8)', () => {
  test('channel and dm: a user with a leaf adds a new device by external commit at once', async () => {
    const w = await newWorld()
    const alice = w.repo.addUser()
    const bob = w.repo.addUser()
    const aDev = await activeDevice(w, alice)
    await activeDevice(w, bob)
    const dm = w.repo.addDm([alice, bob])
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId: dm }, aDev.id))
    const g = await activate(w, out, (await w.repo.listGroupsByChannel(dm))[0]!, aDev)
    const aDev2 = await activeDevice(w, alice)
    const jr = await join(w, g.groupId, { userId: alice, device: aDev2 })
    assert.equal(jr.status, 'external_commit')
    assert.equal((await w.repo.listPending(g.groupId, ['queued'])).some((p) => p.deviceId === aDev2.id), false)
  })

  test('GroupFull above TAKUSEN_PUBLIC_SET_MAX_MEMBERS', async () => {
    const w = await newWorld({ TAKUSEN_PUBLIC_SET_MAX_MEMBERS: '1' })
    const { group, members } = await publicGuild(w, 1)
    const err = await rejects(postJoinRequest(w.repo, w.deps, new Outbox(), members[0]!, group.groupId, fakeKeyPackage(members[0]!.device)), 'GroupFull')
    assert.equal(err.status, 403)
  })

  test('rejected no_key_package when no key package exists in the group suite', async () => {
    const w = await newWorld({ TAKUSEN_MLS_SUITES: '1,83' })
    const { group, members } = await publicGuild(w, 1)
    const m = members[0]!
    const jr = await postJoinRequest(w.repo, w.deps, new Outbox(), m, group.groupId, fakeKeyPackage(m.device, 83))
    assert.equal(jr.status, 'rejected')
    assert.equal(jr.reason, 'no_key_package')
  })

  test('a reader check: a non-member of the guild gets 404 UnknownGroup', async () => {
    const w = await newWorld()
    const { group } = await publicGuild(w, 0)
    const stranger = w.repo.addUser()
    const d = await activeDevice(w, stranger)
    await rejects(postJoinRequest(w.repo, w.deps, new Outbox(), { userId: stranger, device: d }, group.groupId, fakeKeyPackage(d)), 'UnknownGroup')
  })
})

describe('key packages (§12.7.2)', () => {
  test('atomic pop of one-time packages, then the last resort; KEY_PACKAGES_LOW', async () => {
    const w = await newWorld()
    const userId = w.repo.addUser()
    const d = await activeDevice(w, userId)
    const kps = [fakeKeyPackage(d), fakeKeyPackage(d), fakeKeyPackage(d)]
    const lr = fakeKeyPackage(d)
    assert.deepEqual(await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 1, keyPackages: kps, lastResort: lr }), { stored: 3, total: 3 })
    assert.deepEqual(await countKeyPackages(w.repo, d), [{ cipherSuite: 1, count: 3, lastResort: true }])
    const claims = await Promise.all([0, 1, 2].map(() => w.repo.transaction((r) => r.claimKeyPackage(d.id, 1))))
    assert.deepEqual(new Set(claims.map((c) => Buffer.from(c!.data).toString())), new Set(kps.map((k) => Buffer.from(k).toString())))
    for (let i = 0; i < 2; i++) {
      const c = await w.repo.claimKeyPackage(d.id, 1)
      assert.equal(c!.lastResort, true)
      assert.deepEqual(c!.data, lr)
    }

    // A queued Add by value claims a package and reports the low count.
    const other = w.repo.addUser()
    const oDev = await activeDevice(w, other)
    const dm = w.repo.addDm([other, userId])
    const out = new Outbox()
    await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 1, keyPackages: [fakeKeyPackage(d)], lastResort: null })
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId: dm }, oDev.id))
    await activate(w, out, (await w.repo.listGroupsByChannel(dm))[0]!, oDev)
    const low = out.events.find((e) => e.t === 'KEY_PACKAGES_LOW')!
    assert.equal(low.channel, `device:${d.id}`)
    assert.deepEqual(low.d, { deviceId: d.id, cipherSuite: 1, remaining: 0 })
  })

  test('upload checks: identity, key, suite, chain generation', async () => {
    const w = await newWorld()
    const userId = w.repo.addUser()
    const d = await activeDevice(w, userId)
    const other = await activeDevice(w, userId)
    const up = (kp: Uint8Array, suite = 1) => uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: suite, keyPackages: [kp], lastResort: null })
    await rejects(up(fakeKeyPackage(other)), 'InvalidKeyPackage')
    await rejects(up(fakeKeyPackage(d, 83), 83), 'InvalidKeyPackage')
    await rejects(up(fakeKeyPackage({ ...d, dskGeneration: 2 })), 'InvalidKeyPackage')
    await rejects(up(fakeKeyPackage(d, 1, w.clock.now - 1)), 'InvalidKeyPackage')
    await rejects(up(new TextEncoder().encode('junk')), 'InvalidKeyPackage')
  })
})
