/**
 * Invites with history (docs/gateway-protocol.md §4, §12.11.4, §12.12): the
 * record checks, the bundle routes and the sweep on the in-memory stores, and
 * the InviteHistoryStore conformance suite on InMemoryInviteHistoryStore. No
 * DB: invite-history.pg.test.ts runs the suite on Postgres.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'

import { DEFAULT_EVERYONE } from '@hachiman/client/permissions'

import type { InviteRow } from '@/db/schema'
import { ApiError, ValidationError } from '@/lib/errors'
import { toB64 } from '@/lib/mls/bytes'
import { INVITE_BUNDLE_FETCH_WINDOW_MS, INVITE_BUNDLE_MAX_BYTES, INVITE_BUNDLES_MAX_BYTES, type DsModule, type InviteRecordView } from '@/lib/mls/crypto'
import { encodeGroupId } from '@/lib/mls/groups'
import { InMemoryMlsRepo } from '@/lib/mls/repo.in-memory'

import {
  checkInviteRecord,
  INVITE_BUNDLES_SENDER_MAX_BYTES,
  INVITE_RECORD_EXPIRY_SKEW_MS,
  inviteBundlesOf,
  isInviteActive,
  listInviteRecords,
  postInviteBundle,
  sweepInviteBundles,
  type RecordExpectation,
} from './invite-history'
import { describeInviteHistoryStore, historySeed } from './invite-history.conformance'
import { InMemoryInviteHistoryStore } from './invite-history.in-memory'

describeInviteHistoryStore('InMemoryInviteHistoryStore', async () => {
  const store = new InMemoryInviteHistoryStore()
  return {
    store,
    fx: {
      addUser: async () => randomUUID(),
      addGuild: async () => randomUUID(),
      addInvite: async ({ history, ...seed }) => store.addInvite({ ...seed, ...(history && historySeed()) }),
    },
  }
})

const HOUR_MS = 3_600_000
const NOW = new Date('2026-10-06T12:00:00Z')

function apiCode(code: string, status: number) {
  return (err: unknown) => err instanceof ApiError && err.code === code && err.status === status
}

describe('checkInviteRecord', () => {
  const keyId = new Uint8Array(32).fill(7)
  const [c1, c2] = [randomUUID(), randomUUID()]
  const expect: RecordExpectation = { guildId: 'g1', userId: 'u1', deviceId: 'd1', maxAgeSeconds: 86_400, maxUses: 1, now: NOW, guildChannelIds: new Set([c1, c2]) }
  const view = (over: Partial<InviteRecordView> = {}): InviteRecordView => ({
    guildId: 'g1',
    hpkePublic: toB64(new Uint8Array(32)),
    keyId: toB64(keyId),
    channelIds: [c1, c2],
    adminChainSeq: 3,
    expiresAtMs: NOW.getTime() + 86_400_000,
    maxUses: 1,
    creatorUserId: 'u1',
    creatorDeviceId: 'd1',
    ...over,
  })

  test('returns the key id of a record that matches the request', () => {
    assert.deepEqual(checkInviteRecord(view(), expect), keyId)
    assert.deepEqual(checkInviteRecord(view({ expiresAtMs: 0 }), { ...expect, maxAgeSeconds: 0 }), keyId)
    assert.deepEqual(checkInviteRecord(view({ expiresAtMs: NOW.getTime() + 86_400_000 - INVITE_RECORD_EXPIRY_SKEW_MS }), expect), keyId)
    assert.deepEqual(checkInviteRecord(view({ channelIds: [] }), { ...expect, guildChannelIds: new Set() }), keyId)
  })

  test('rejects a record that does not verify, or that is not for this guild, user, device, body or channels', () => {
    const bad: [InviteRecordView | null, RecordExpectation][] = [
      [null, expect],
      [view({ guildId: 'g2' }), expect],
      [view({ creatorUserId: 'u2' }), expect],
      [view({ creatorDeviceId: 'd2' }), expect],
      [view({ maxUses: 0 }), expect],
      [view({ expiresAtMs: 0 }), expect],
      [view(), { ...expect, maxAgeSeconds: 0 }],
      [view({ expiresAtMs: NOW.getTime() + 86_400_000 + INVITE_RECORD_EXPIRY_SKEW_MS + 1 }), expect],
      [view({ channelIds: Array.from({ length: 501 }, () => randomUUID()) }), expect],
      // A channel of another guild, or no channel.
      [view({ channelIds: [c1, randomUUID()] }), expect],
      [view(), { ...expect, guildChannelIds: new Set([c1]) }],
      [view({ keyId: toB64(new Uint8Array(16)) }), expect],
      [view({ keyId: 'not base64url!' }), expect],
    ]
    for (const [v, e] of bad) assert.throws(() => checkInviteRecord(v, e), ValidationError, JSON.stringify(v))
  })
})

describe('isInviteActive', () => {
  const base = { revoked: false, expiresAt: null, exhaustedAt: null, maxUses: null, uses: 0 }
  test('only an invite that is not revoked, expired or exhausted', () => {
    assert.equal(isInviteActive(base, NOW), true)
    assert.equal(isInviteActive({ ...base, expiresAt: new Date(NOW.getTime() + 1), maxUses: 2, uses: 1 }, NOW), true)
    assert.equal(isInviteActive({ ...base, revoked: true }, NOW), false)
    assert.equal(isInviteActive({ ...base, expiresAt: NOW }, NOW), false)
    assert.equal(isInviteActive({ ...base, exhaustedAt: NOW }, NOW), false)
    assert.equal(isInviteActive({ ...base, maxUses: 1, uses: 1 }, NOW), false)
  })
})

/** A DsModule that gives each record the scope `channelIds` (the records of the in-memory store are random bytes). */
function scopeDs(channelIds: string[] = []): Pick<DsModule, 'parseInviteRecord'> {
  return {
    parseInviteRecord: () => ({ guildId: '', hpkePublic: '', keyId: '', channelIds, adminChainSeq: 0, expiresAtMs: 0, maxUses: 0, creatorUserId: '', creatorDeviceId: '' }),
  }
}

/** A guild with a public_set group at epoch 5, a reader and a stranger, and an invite with history. */
async function world() {
  const mls = new InMemoryMlsRepo()
  const store = new InMemoryInviteHistoryStore()
  const owner = mls.addUser()
  const guild = mls.addGuild(owner, undefined, DEFAULT_EVERYONE)
  const member = mls.addUser()
  mls.addGuildMember(guild, member)
  const stranger = mls.addUser()
  const groupId = encodeGroupId('public_set', guild, 0)
  await mls.insertGroup({
    groupId,
    kind: 'public_set',
    scopeId: guild,
    guildId: guild,
    channelId: null,
    generation: 0,
    cipherSuite: 1,
    status: 'active',
    epoch: 5,
    groupInfo: null,
    ratchetTree: null,
    historyVisibility: 'shared',
  })
  const invite = store.addInvite({ guildId: guild, createdBy: owner, ...historySeed() })
  const caller = { userId: member, device: { id: randomUUID() } }
  const creator = { userId: owner, device: { id: randomUUID() } }
  return { mls, store, ds: scopeDs(), owner, guild, member, stranger, groupId, invite, caller, creator }
}

describe('listInviteRecords', () => {
  test('gives the wire shape of the active records', async () => {
    const w = await world()
    await postInviteBundle(w.store, w.mls, w.ds, w.caller, w.invite.id, { groupId: w.groupId, epoch: 4, blob: new Uint8Array(8) }, NOW)
    w.store.addInvite({ guildId: w.guild, createdBy: w.owner })
    assert.deepEqual(await listInviteRecords(w.store, w.guild, NOW), [
      {
        inviteId: w.invite.id,
        keyId: toB64(w.invite.keyId!),
        record: toB64(w.invite.record!),
        expiresAt: null,
        bundled: [{ groupId: toB64(w.groupId), epoch: 4 }],
      },
    ])
  })
})

describe('postInviteBundle', () => {
  test('a reader of a group of the guild stores a bundle, and the oldest go above 4 MiB', async () => {
    const w = await world()
    const n = Math.ceil(INVITE_BUNDLES_MAX_BYTES / INVITE_BUNDLE_MAX_BYTES) + 1
    await w.mls.updateGroup(w.groupId, { epoch: n })
    for (let epoch = 0; epoch < n; epoch++) {
      await postInviteBundle(w.store, w.mls, w.ds, w.creator, w.invite.id, { groupId: w.groupId, epoch, blob: new Uint8Array(INVITE_BUNDLE_MAX_BYTES) }, NOW)
    }
    const kept = await w.store.listBundles(w.invite.id)
    assert.equal(kept.length, Math.floor(INVITE_BUNDLES_MAX_BYTES / INVITE_BUNDLE_MAX_BYTES))
    assert.equal(kept.at(-1)!.epoch, n - 1, 'the newest stays')
    assert.equal(kept.at(-1)!.senderDevice, w.creator.device.id)
  })

  test('a member keeps at most 1 MiB over all its devices, so it cannot push out the bundles of the creator', async () => {
    const w = await world()
    const big = new Uint8Array(INVITE_BUNDLE_MAX_BYTES)
    const creation = Math.floor((INVITE_BUNDLES_MAX_BYTES - INVITE_BUNDLES_SENDER_MAX_BYTES) / INVITE_BUNDLE_MAX_BYTES)
    for (let i = 0; i < creation; i++) {
      await postInviteBundle(w.store, w.mls, w.ds, w.creator, w.invite.id, { groupId: w.groupId, epoch: 5, blob: big }, NOW)
    }
    // Four devices, or a device that is revoked and replaced: a share per device would push out the creation bundles.
    const devices = Array.from({ length: 4 }, () => ({ id: randomUUID() }))
    const flood = Math.ceil(INVITE_BUNDLES_MAX_BYTES / INVITE_BUNDLE_MAX_BYTES) + 1
    for (let i = 0; i < flood; i++) {
      const device = devices[i % devices.length]!
      await postInviteBundle(w.store, w.mls, w.ds, { ...w.caller, device }, w.invite.id, { groupId: w.groupId, epoch: 5, blob: big }, NOW)
    }
    const second = w.mls.addUser()
    w.mls.addGuildMember(w.guild, second)
    await postInviteBundle(w.store, w.mls, w.ds, { userId: second, device: { id: randomUUID() } }, w.invite.id, { groupId: w.groupId, epoch: 5, blob: new Uint8Array(8) }, NOW)

    const by = (user: string) => w.store.bundles.filter((b) => b.senderUser === user)
    assert.ok(creation * INVITE_BUNDLE_MAX_BYTES > INVITE_BUNDLES_SENDER_MAX_BYTES, 'the creator is above the share of one user')
    assert.ok(devices.length * INVITE_BUNDLES_SENDER_MAX_BYTES + creation * INVITE_BUNDLE_MAX_BYTES > INVITE_BUNDLES_MAX_BYTES)
    assert.equal(by(w.owner).length, creation)
    assert.equal(by(w.member).length, Math.floor(INVITE_BUNDLES_SENDER_MAX_BYTES / INVITE_BUNDLE_MAX_BYTES))
    assert.equal(by(w.member).at(-1), w.store.bundles.at(-2), 'the newest of the member stays')
    assert.equal(by(w.member).at(-1)!.senderDevice, devices[(flood - 1) % devices.length]!.id)
    assert.equal(by(second).length, 1, 'another member has its own share')
  })

  test('rejects a large blob, a group that the caller cannot read and an epoch ahead of the group', async () => {
    const w = await world()
    const post = (caller: typeof w.caller, body: { groupId: Uint8Array; epoch: number; blob: Uint8Array }) =>
      postInviteBundle(w.store, w.mls, w.ds, caller, w.invite.id, body, NOW)
    await assert.rejects(post(w.caller, { groupId: w.groupId, epoch: 5, blob: new Uint8Array(INVITE_BUNDLE_MAX_BYTES + 1) }), apiCode('ValidationError', 400))
    await assert.rejects(post({ ...w.caller, userId: w.stranger }, { groupId: w.groupId, epoch: 5, blob: new Uint8Array(1) }), apiCode('UnknownGroup', 404))
    await assert.rejects(post(w.caller, { groupId: encodeGroupId('public_set', randomUUID(), 0), epoch: 5, blob: new Uint8Array(1) }), apiCode('UnknownGroup', 404))
    await assert.rejects(post(w.caller, { groupId: w.groupId, epoch: 6, blob: new Uint8Array(1) }), apiCode('ValidationError', 400))
    assert.deepEqual(await w.store.listBundles(w.invite.id), [])
  })

  test('accepts the channel group of a channel that the record names, and rejects another channel group', async () => {
    const w = await world()
    const channelGroup = async (channelId: string) => {
      const groupId = encodeGroupId('channel', channelId, 0)
      await w.mls.insertGroup({
        groupId,
        kind: 'channel',
        scopeId: channelId,
        guildId: w.guild,
        channelId,
        generation: 0,
        cipherSuite: 1,
        status: 'active',
        epoch: 2,
        groupInfo: null,
        ratchetTree: null,
        historyVisibility: 'joined',
      })
      return groupId
    }
    const named = w.mls.addChannel({ guildId: w.guild, type: 'text' })
    const other = w.mls.addChannel({ guildId: w.guild, type: 'text' })
    const ds = scopeDs([named])
    // The member reads both channels. Without the scope check, a reader of a private channel could post wrong keys for its group.
    await postInviteBundle(w.store, w.mls, ds, w.caller, w.invite.id, { groupId: await channelGroup(named), epoch: 2, blob: new Uint8Array(1) }, NOW)
    await assert.rejects(
      postInviteBundle(w.store, w.mls, ds, w.caller, w.invite.id, { groupId: await channelGroup(other), epoch: 2, blob: new Uint8Array(1) }, NOW),
      apiCode('ValidationError', 400),
    )
    assert.deepEqual(
      w.store.bundles.map((b) => toB64(b.groupId)),
      [toB64(encodeGroupId('channel', named, 0))],
    )
  })

  test('gives 404 UnknownInvite for an unknown invite, another guild, no record, or an invite that is not active', async () => {
    const w = await world()
    const seed = { guildId: w.guild, createdBy: w.owner, ...historySeed() }
    const ids = [
      randomUUID(),
      w.store.addInvite({ ...seed, guildId: randomUUID() }).id,
      w.store.addInvite({ guildId: w.guild, createdBy: w.owner }).id,
      w.store.addInvite({ ...seed, revoked: true }).id,
      w.store.addInvite({ ...seed, expiresAt: NOW }).id,
      w.store.addInvite({ ...seed, maxUses: 1, uses: 1, exhaustedAt: NOW }).id,
    ]
    for (const id of ids) {
      await assert.rejects(postInviteBundle(w.store, w.mls, w.ds, w.caller, id, { groupId: w.groupId, epoch: 5, blob: new Uint8Array(1) }, NOW), apiCode('UnknownInvite', 404))
    }
    assert.deepEqual(w.store.bundles, [])
  })
})

describe('inviteBundlesOf', () => {
  async function redeemed(over: Partial<InviteRow> = {}) {
    const w = await world()
    Object.assign(w.invite, over)
    await postInviteBundle(w.store, w.mls, w.ds, w.caller, w.invite.id, { groupId: w.groupId, epoch: 5, blob: new Uint8Array([1, 2]) }, NOW)
    const redeemer = randomUUID()
    await w.store.joinWithInvite(w.invite, redeemer, NOW)
    return { ...w, redeemer }
  }

  test('gives the record and the bundles to the redeemer during the window, also after the last use', async () => {
    const w = await redeemed({ maxUses: 1 })
    assert.notEqual(w.invite.exhaustedAt, null)
    const later = new Date(NOW.getTime() + INVITE_BUNDLE_FETCH_WINDOW_MS)
    assert.deepEqual(await inviteBundlesOf(w.store, w.invite, w.redeemer, later), {
      inviteId: w.invite.id,
      record: toB64(w.invite.record!),
      bundles: [{ groupId: toB64(w.groupId), epoch: 5, blob: toB64(new Uint8Array([1, 2])), senderDevice: w.caller.device.id }],
    })
  })

  test('gives 404 UnknownInvite to everyone else, after the window, and for a revoked invite', async () => {
    const w = await redeemed()
    const other = w.store.addInvite({ guildId: w.guild, createdBy: w.owner, ...historySeed() })
    const plain = w.store.addInvite({ guildId: w.guild, createdBy: w.owner })
    w.store.addMember(w.guild, w.member, { inviteId: other.id, joinedAt: NOW })
    const cases: [InviteRow | null, string, Date][] = [
      [null, w.redeemer, NOW],
      [w.invite, w.member, NOW],
      [w.invite, w.stranger, NOW],
      [w.invite, w.redeemer, new Date(NOW.getTime() + INVITE_BUNDLE_FETCH_WINDOW_MS + 1)],
      [{ ...w.invite, revoked: true }, w.redeemer, NOW],
      [plain, w.redeemer, NOW],
    ]
    for (const [invite, userId, now] of cases) {
      await assert.rejects(inviteBundlesOf(w.store, invite, userId, now), apiCode('UnknownInvite', 404))
    }
  })
})

describe('sweepInviteBundles', () => {
  test('deletes the bundles of invites that ended more than an hour ago', async () => {
    const w = await world()
    const ended = w.store.addInvite({ guildId: w.guild, createdBy: w.owner, ...historySeed(), expiresAt: new Date(NOW.getTime() + 60_000) })
    for (const inv of [w.invite, ended]) {
      await postInviteBundle(w.store, w.mls, w.ds, w.caller, inv.id, { groupId: w.groupId, epoch: 5, blob: new Uint8Array(1) }, NOW)
    }
    assert.equal(await sweepInviteBundles(w.store, new Date(NOW.getTime() + HOUR_MS)), 0, 'expired 59 min ago')
    assert.equal(await sweepInviteBundles(w.store, new Date(NOW.getTime() + 2 * HOUR_MS)), 1)
    assert.equal((await w.store.listBundles(w.invite.id)).length, 1)
  })
})
