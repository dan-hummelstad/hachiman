/**
 * Envelope acceptance (docs/gateway-protocol.md §12.8.4), Welcome fan-out and
 * the device inbox caps (§12.7.6).
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, test } from 'node:test'

import { ApiError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'

import { uuidToBytes } from './bytes'
import { uploadCommit } from './commits'
import { INBOX_DEVICE_MAX_BYTES, INBOX_ITEM_MAX_BYTES } from './config'
import { postInbox } from './device-data'
import { acceptEnvelopeWith, type EnvelopeInput } from './envelopes'
import { Outbox } from './events'
import { uploadKeyPackages } from './key-packages'
import { onMembershipChangeWith } from './membership'
import { activate, activeDevice, commitRequest, fakeKeyPackage, newWorld, runBatchAndCommit, testEnvelope, type World } from './testing'
import { decodeWelcomeItem } from './wire-format'

setBusPublisher(async () => undefined)

async function rejects(p: Promise<unknown>, code: string, status: number): Promise<ApiError> {
  try {
    await p
  } catch (err) {
    assert.ok(err instanceof ApiError, String(err))
    assert.equal(err.code, code, err.message)
    assert.equal(err.status, status)
    return err
  }
  assert.fail(`expected ${code}`)
}

/** A DM where alice (two devices) and bob (two devices) all have leaves, at epoch 1. */
async function world() {
  const w = await newWorld()
  const alice = w.repo.addUser()
  const bob = w.repo.addUser()
  const a1 = await activeDevice(w, alice)
  const a2 = await activeDevice(w, alice)
  const b1 = await activeDevice(w, bob)
  const b2 = await activeDevice(w, bob)
  for (const d of [a2, b1, b2]) await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 1, keyPackages: [fakeKeyPackage(d)], lastResort: null })
  const channelId = w.repo.addDm([alice, bob])
  const out = new Outbox()
  await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId }, a1.id))
  const group = await activate(w, out, (await w.repo.listGroupsByChannel(channelId))[0]!, a1)
  const commitOut = new Outbox()
  await runBatchAndCommit(w, group.groupId, commitOut)
  return { w, alice, bob, a1, a2, b1, b2, channelId, groupId: group.groupId, commitOut }
}

function input(w: World, s: Awaited<ReturnType<typeof world>>, over: Partial<{ epoch: number; leaf: number; device: string; channel: string; groupId: Uint8Array; cmid: Uint8Array }> = {}, base: Partial<EnvelopeInput> = {}): EnvelopeInput {
  const envelope = testEnvelope({
    groupId: over.groupId ?? s.groupId,
    channelId: over.channel ?? s.channelId,
    epoch: over.epoch ?? 1,
    senderLeaf: over.leaf ?? 0,
    senderDeviceId: over.device ?? s.a1.id,
    ...(over.cmid ? { clientMsgId: over.cmid } : {}),
  })
  void w
  return { channelId: s.channelId, userId: s.alice, deviceId: s.a1.id, envelope, edit: false, ...base } as EnvelopeInput
}

const accept = (w: World, i: EnvelopeInput) => acceptEnvelopeWith(w.repo, { ds: w.ds, maxEnvelopeBytes: w.config.maxEnvelopeBytes, now: new Date(w.clock.now) }, i)

describe('Welcome delivery (§12.7.6)', () => {
  test('one Welcome inbox item per new device, with the group and the new epoch', async () => {
    const s = await world()
    for (const d of [s.a2, s.b1, s.b2]) {
      const items = await s.w.repo.listInbox(d.id, 0, 10, new Date(s.w.clock.now))
      assert.equal(items.length, 1)
      const w = decodeWelcomeItem(items[0]!.body)
      assert.deepEqual(w.groupId, s.groupId)
      assert.equal(w.epoch, 1)
    }
    assert.equal((await s.w.repo.listInbox(s.a1.id, 0, 10, new Date(s.w.clock.now))).length, 0, 'the committer gets no Welcome')
    assert.equal(s.commitOut.events.filter((e) => e.t === 'DEVICE_INBOX').length, 3)
  })
})

describe('the device inbox (§12.7.6)', () => {
  function sealed(kind: 2 | 3, sender: string, size: number): Uint8Array {
    const ct = new Uint8Array(size)
    const prefix = size < 0x40 ? [size] : size < 0x4000 ? [0x40 | (size >> 8), size & 0xff] : [0x80 | (size >>> 24), (size >>> 16) & 0xff, (size >>> 8) & 0xff, size & 0xff]
    return new Uint8Array([1, kind, ...uuidToBytes(sender), ...new Uint8Array(32), ...prefix, ...ct])
  }

  test('same user only, the sealed sender is the caller, 1 MiB per item and 8 MiB per device', async () => {
    const s = await world()
    const now = new Date(s.w.clock.now)
    const out = new Outbox()
    const caller = { userId: s.alice, device: s.a1 }
    await rejects(postInbox(s.w.repo, out, caller, s.b1.id, { kind: 'history_keys', body: sealed(3, s.a1.id, 10) }, now), 'UnknownDevice', 404)
    await rejects(postInbox(s.w.repo, out, caller, s.a2.id, { kind: 'dsk_transfer', body: sealed(3, s.a1.id, 10) }, now), 'ValidationError', 400)
    await rejects(postInbox(s.w.repo, out, caller, s.a2.id, { kind: 'history_keys', body: sealed(3, s.a2.id, 10) }, now), 'ValidationError', 400)
    await rejects(postInbox(s.w.repo, out, caller, s.a2.id, { kind: 'history_keys', body: sealed(3, s.a1.id, INBOX_ITEM_MAX_BYTES) }, now), 'InboxFull', 413)

    const chunk = INBOX_ITEM_MAX_BYTES - 64
    const used = await s.w.repo.inboxBytes(s.a2.id, now)
    let n = 0
    while (used + (n + 1) * (chunk + 54) <= INBOX_DEVICE_MAX_BYTES) {
      await postInbox(s.w.repo, out, caller, s.a2.id, { kind: 'history_keys', body: sealed(3, s.a1.id, chunk) }, now)
      n++
    }
    assert.ok(n >= 7)
    await rejects(postInbox(s.w.repo, out, caller, s.a2.id, { kind: 'history_keys', body: sealed(3, s.a1.id, chunk) }, now), 'InboxFull', 413)
    assert.equal(out.events.filter((e) => e.t === 'DEVICE_INBOX' && e.channel === `device:${s.a2.id}`).length, n)
  })
})

describe('envelope checks (§12.8.4)', () => {
  test('a valid envelope gives the stored fields', async () => {
    const s = await world()
    const i = input(s.w, s)
    const r = await accept(s.w, i)
    assert.deepEqual(r.groupId, s.groupId)
    assert.equal(r.epoch, 1)
    assert.equal(r.senderDeviceId, s.a1.id)
    assert.equal(r.size, i.envelope.length)
    assert.equal(r.clientMsgId.length, 16)
    assert.equal(r.frankingTag.length, 32)
  })

  test('size, decode, group, channel', async () => {
    const s = await world()
    await rejects(accept(s.w, { ...input(s.w, s), envelope: new Uint8Array(s.w.config.maxEnvelopeBytes + 1) }), 'EnvelopeTooLarge', 413)
    await rejects(accept(s.w, { ...input(s.w, s), envelope: new Uint8Array([1, 2, 3]) }), 'InvalidEnvelope', 400)
    const otherGroup = new Uint8Array(randomBytes(22))
    await rejects(accept(s.w, input(s.w, s, { groupId: otherGroup })), 'InvalidEnvelope', 400)
    await rejects(accept(s.w, input(s.w, s, { channel: crypto.randomUUID() })), 'InvalidEnvelope', 400)
  })

  test('a group that is not active yet gives 409 GroupPending', async () => {
    const w = await newWorld()
    const alice = w.repo.addUser()
    const bob = w.repo.addUser()
    const a = await activeDevice(w, alice)
    const channelId = w.repo.addDm([alice, bob])
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, new Outbox(), { kind: 'dm_created', channelId }, a.id))
    const g = (await w.repo.listGroupsByChannel(channelId))[0]!
    const envelope = testEnvelope({ groupId: g.groupId, channelId, epoch: 0, senderLeaf: 0, senderDeviceId: a.id })
    await rejects(accept(w, { channelId, userId: alice, deviceId: a.id, envelope, edit: false }), 'GroupPending', 409)
  })

  test('the epoch grace: epoch - 1 only within 10 s of a commit that removed no other leaf', async () => {
    const s = await world()
    await accept(s.w, input(s.w, s, { epoch: 0 }))
    s.w.clock.now += 10_001
    const late = await rejects(accept(s.w, input(s.w, s, { epoch: 0 })), 'StaleEpoch', 409)
    assert.deepEqual(late.extra, { epoch: 1 })
    await rejects(accept(s.w, input(s.w, s, { epoch: 2 })), 'StaleEpoch', 409)

    // Alice removes her own second device: that removes another device's leaf, so no grace.
    const a2Leaf = (await s.w.repo.memberByDevice(s.groupId, s.a2.id))!.leafIndex
    const body = await commitRequest(s.w, s.groupId, s.a1, { refs: [], adds: [], removes: [a2Leaf] })
    await uploadCommit(s.w.repo, s.w.deps, new Outbox(), { userId: s.alice, device: s.a1 }, s.groupId, body)
    await accept(s.w, input(s.w, s, { epoch: 2 }))
    await rejects(accept(s.w, input(s.w, s, { epoch: 1 })), 'StaleEpoch', 409)
  })

  test('NotMember: another device, a wrong sender leaf, a device without a leaf', async () => {
    const s = await world()
    await rejects(accept(s.w, input(s.w, s, { device: s.a2.id })), 'NotMember', 403)
    await rejects(accept(s.w, input(s.w, s, { leaf: 3 })), 'NotMember', 403)
    const a3 = await activeDevice(s.w, s.alice)
    await rejects(accept(s.w, { ...input(s.w, s, { device: a3.id }), deviceId: a3.id }), 'NotMember', 403)
    // Bob's device with Bob's leaf, sent as Alice: the leaf user is not the caller.
    const bLeaf = (await s.w.repo.memberByDevice(s.groupId, s.b1.id))!.leafIndex
    await rejects(accept(s.w, { ...input(s.w, s, { device: s.b1.id, leaf: bLeaf }), deviceId: s.b1.id }), 'NotMember', 403)
  })

  test('DuplicateMessage, and the edit rules', async () => {
    const s = await world()
    const cmid = new Uint8Array(randomBytes(16))
    await accept(s.w, input(s.w, s, { cmid }))
    s.w.repo.addMessageClientMsgId(s.channelId, cmid)
    await rejects(accept(s.w, input(s.w, s, { cmid })), 'DuplicateMessage', 409)
    // An edit repeats the client_msg_id of the row, and skips the uniqueness check.
    const edit = await accept(s.w, { ...input(s.w, s, { cmid }), edit: true, rowClientMsgId: cmid })
    assert.deepEqual(edit.clientMsgId, cmid)
    await rejects(accept(s.w, { ...input(s.w, s), edit: true, rowClientMsgId: cmid }), 'InvalidEnvelope', 400)
  })
})
