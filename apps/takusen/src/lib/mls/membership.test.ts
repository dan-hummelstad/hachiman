/**
 * Membership changes (§12.6 channel moves, §12.18 onMembershipChange) and the
 * smaller DS stores: handshake catch-up, backups and device linking.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { Permissions } from '@hachiman/client/permissions'

import { ApiError } from '@/lib/errors'
import { setBusPublisher } from '@/lib/events'

import { uuidToBytes } from './bytes'
import { createLinkSession, fetchHandshakes, postHistoryBackup, postLinkMessage, putIdentityBackup } from './device-data'
import { Outbox } from './events'
import { uploadKeyPackages } from './key-packages'
import type { Tx } from '@/db/client'
import { membershipTransactionWith } from '@/lib/guilds'

import { hasMembershipWork, onMembershipChangeWith, recordMembershipChange, wakeScheduler } from './membership'
import { activate, activeDevice, fakeKeyPackage, newWorld, runBatchAndCommit } from './testing'
import { encodeForTests } from './wire-format'

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

describe('channel moves (§12.6)', () => {
  test('public → private allocates a channel group; private → public returns to public_set and retires it', async () => {
    const w = await newWorld()
    const owner = w.repo.addUser()
    const guildId = w.repo.addGuild(owner, undefined, Permissions.VIEW_CHANNEL)
    const channelId = w.repo.addChannel({ guildId, type: 'text' })
    const oDev = await activeDevice(w, owner)
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'guild_created', guildId }, oDev.id))
    const set = (await w.repo.listGroupsByGuild(guildId)).find((g) => g.kind === 'public_set')!
    assert.deepEqual((await w.repo.getChannel(channelId))!.mlsGroupId, set.groupId)
    await activate(w, out, set, oDev)

    w.repo.setOverwrites(channelId, [{ id: guildId, type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL }])
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'overwrites_changed', channelId }, oDev.id))
    const own = (await w.repo.listGroupsByChannel(channelId)).find((g) => g.kind === 'channel')!
    assert.equal(own.status, 'pending')
    assert.equal(own.historyVisibility, 'joined')
    assert.deepEqual((await w.repo.getChannel(channelId))!.mlsGroupId, own.groupId)
    assert.equal((await w.repo.getGroup(set.groupId))!.status, 'active', 'the public_set group keeps the old messages')

    w.repo.setOverwrites(channelId, [])
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'overwrites_changed', channelId }, oDev.id))
    assert.deepEqual((await w.repo.getChannel(channelId))!.mlsGroupId, set.groupId)
    assert.equal((await w.repo.getGroup(own.groupId))!.status, 'retired')
  })

  test('a pages channel is in public_set, or in its own channel group when the overwrites hide it', async () => {
    const w = await newWorld()
    const owner = w.repo.addUser()
    const guildId = w.repo.addGuild(owner, undefined, Permissions.VIEW_CHANNEL)
    const oDev = await activeDevice(w, owner)
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'guild_created', guildId }, oDev.id))
    const set = (await w.repo.listGroupsByGuild(guildId)).find((g) => g.kind === 'public_set')!

    const open = w.repo.addChannel({ guildId, type: 'pages' })
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'channel_created', channelId: open }, oDev.id))
    assert.deepEqual((await w.repo.getChannel(open))!.mlsGroupId, set.groupId)

    const hidden = w.repo.addChannel({ guildId, type: 'pages' })
    w.repo.setOverwrites(hidden, [{ id: guildId, type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL }])
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'channel_created', channelId: hidden }, oDev.id))
    const own = (await w.repo.listGroupsByChannel(hidden)).find((g) => g.kind === 'channel')!
    assert.deepEqual((await w.repo.getChannel(hidden))!.mlsGroupId, own.groupId)
  })

  test('a new reader of a private channel gets an Add by value; losing the role queues a Remove', async () => {
    const w = await newWorld()
    const owner = w.repo.addUser()
    const guildId = w.repo.addGuild(owner, undefined, Permissions.VIEW_CHANNEL)
    const staff = w.repo.addRole(guildId, 0)
    const channelId = w.repo.addChannel({ guildId, type: 'text' })
    w.repo.setOverwrites(channelId, [
      { id: guildId, type: 'role', allow: 0, deny: Permissions.VIEW_CHANNEL },
      { id: staff, type: 'role', allow: Permissions.VIEW_CHANNEL, deny: 0 },
    ])
    const oDev = await activeDevice(w, owner)
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'channel_created', channelId }, oDev.id))
    const g = await activate(w, out, (await w.repo.listGroupsByChannel(channelId))[0]!, oDev)

    const dana = w.repo.addUser()
    w.repo.addGuildMember(guildId, dana, [])
    const dDev = await activeDevice(w, dana)
    await uploadKeyPackages(w.repo, w.deps, dDev, { cipherSuite: 1, keyPackages: [fakeKeyPackage(dDev)], lastResort: null })
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'guild_member_added', guildId, userId: dana }, null))
    assert.equal((await w.repo.listPending(g.groupId, ['queued'])).length, 0, 'not a reader yet')

    w.repo.addGuildMember(guildId, dana, [staff])
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'member_roles_changed', guildId, userId: dana }, null))
    const [add] = await w.repo.listPending(g.groupId, ['queued'])
    assert.equal(add!.op, 'add')
    assert.equal(add!.deviceId, dDev.id)
    await runBatchAndCommit(w, g.groupId)
    assert.ok(await w.repo.memberByDevice(g.groupId, dDev.id))

    w.repo.addGuildMember(guildId, dana, [])
    const o2 = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, o2, { kind: 'member_roles_changed', guildId, userId: dana }, null))
    const [rm] = await w.repo.listPending(g.groupId, ['queued'])
    assert.equal(rm!.op, 'remove')
    assert.ok(o2.wake.size === 1)
  })

  test('guild_deleted retires the groups of the guild and drops their work', async () => {
    const w = await newWorld()
    const owner = w.repo.addUser()
    const guildId = w.repo.addGuild(owner, undefined, Permissions.VIEW_CHANNEL)
    w.repo.addChannel({ guildId, type: 'text' })
    const oDev = await activeDevice(w, owner)
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'guild_created', guildId }, oDev.id))
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'guild_deleted', guildId }, null))
    for (const g of await w.repo.listGroupsByGuild(guildId)) {
      assert.equal(g.status, 'retired')
      assert.equal((await w.repo.listBatchesOfGroup(g.groupId)).length, 0)
    }
  })
})

describe('group DM leave and delete', () => {
  test('a participant who leaves gets a Remove; a delete retires the group', async () => {
    const w = await newWorld()
    const [alice, bob, cara] = [w.repo.addUser(), w.repo.addUser(), w.repo.addUser()]
    const a = await activeDevice(w, alice)
    const b = await activeDevice(w, bob)
    const c = await activeDevice(w, cara)
    for (const d of [b, c]) await uploadKeyPackages(w.repo, w.deps, d, { cipherSuite: 1, keyPackages: [fakeKeyPackage(d)], lastResort: null })
    const dm = w.repo.addDm([alice, bob, cara], 'group_dm')
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId: dm }, a.id))
    const g = await activate(w, out, (await w.repo.listGroupsByChannel(dm))[0]!, a)
    await runBatchAndCommit(w, g.groupId)
    assert.ok(await w.repo.memberByDevice(g.groupId, c.id))

    w.repo.removeDmParticipant(dm, cara)
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, new Outbox(), { kind: 'dm_participant_removed', channelId: dm }, b.id))
    const pending = await w.repo.listPending(g.groupId, ['queued'])
    assert.deepEqual(pending.map((p) => [p.op, p.deviceId]), [['remove', c.id]])

    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, new Outbox(), { kind: 'dm_deleted', channelId: dm }, a.id))
    for (const group of await w.repo.listGroupsByChannel(dm)) assert.equal(group.status, 'retired')
  })
})

describe('membership work of a rolled-back transaction (§12.18)', () => {
  test('a thrown transaction leaves no outbox entry and publishes nothing', async () => {
    const w = await newWorld()
    const alice = w.repo.addUser()
    const bob = w.repo.addUser()
    const aDev = await activeDevice(w, alice)
    await activeDevice(w, bob)
    const channelId = w.repo.addDm([alice, bob])
    const tx = { id: 'rolled-back' } as unknown as Tx
    const published: string[] = []
    setBusPublisher(async (channel) => void published.push(channel))
    try {
      await assert.rejects(
        membershipTransactionWith(
          async (fn) => fn(tx),
          async (t) => {
            await recordMembershipChange(t, w.repo, w.deps, { kind: 'dm_created', channelId }, aDev.id)
            assert.ok(hasMembershipWork(t), 'the change recorded work for the transaction')
            throw new Error('rollback')
          },
        ),
        /rollback/,
      )
      assert.equal(hasMembershipWork(tx), false)
      await wakeScheduler(tx)
      assert.deepEqual(published, [])
    } finally {
      setBusPublisher(async () => undefined)
    }
  })
})

describe('handshakes, backups, linking', () => {
  test('a client further behind than the retained handshakes gets 410 HandshakesExpired', async () => {
    const w = await newWorld()
    const alice = w.repo.addUser()
    const bob = w.repo.addUser()
    const a = await activeDevice(w, alice)
    const b = await activeDevice(w, bob)
    await uploadKeyPackages(w.repo, w.deps, b, { cipherSuite: 1, keyPackages: [fakeKeyPackage(b)], lastResort: null })
    const dm = w.repo.addDm([alice, bob])
    const out = new Outbox()
    await w.repo.transaction((r) => onMembershipChangeWith(r, w.deps, out, { kind: 'dm_created', channelId: dm }, a.id))
    const g = await activate(w, out, (await w.repo.listGroupsByChannel(dm))[0]!, a)
    await runBatchAndCommit(w, g.groupId)
    const page = await fetchHandshakes(w.repo, alice, g.groupId, 0, 100)
    assert.equal(page.handshakes.length, 1)
    assert.equal(page.latestSeq, 1)
    w.clock.now += 31 * 86_400_000
    await w.repo.deleteHandshakesBefore(new Date(w.clock.now - 30 * 86_400_000))
    await rejects(fetchHandshakes(w.repo, alice, g.groupId, 0, 100), 'HandshakesExpired')
    assert.equal((await fetchHandshakes(w.repo, alice, g.groupId, 1, 100)).handshakes.length, 0, 'an up-to-date client is fine')
    await rejects(fetchHandshakes(w.repo, w.repo.addUser(), g.groupId, 0, 100), 'UnknownGroup')
  })

  test('history backups need the stored key id', async () => {
    const w = await newWorld()
    const userId = w.repo.addUser()
    const keyId = new Uint8Array(16).fill(1)
    await putIdentityBackup(w.repo, userId, keyId, new Uint8Array(100))
    await rejects(putIdentityBackup(w.repo, userId, keyId, new Uint8Array(64 * 1024 + 1)), 'BackupTooLarge')
    await rejects(postHistoryBackup(w.repo, userId, { keyId: new Uint8Array(16).fill(2), groupId: new Uint8Array(22), epochFrom: 0, epochTo: 3, blob: new Uint8Array(10) }), 'WrongBackupKey')
    const { id } = await postHistoryBackup(w.repo, userId, { keyId, groupId: new Uint8Array(22), epochFrom: 0, epochTo: 3, blob: new Uint8Array(10) })
    assert.ok(id)
  })

  test('a link session: the new device offers, and only one existing device talks to it', async () => {
    const w = await newWorld()
    const userId = w.repo.addUser()
    const existing = await activeDevice(w, userId)
    const third = await activeDevice(w, userId)
    const fresh = await w.repo.insertDevice({ userId, name: 'New', platform: 'browser', clientVersion: '1.0.0' })
    const offerKeys = { mlsSignatureKey: new Uint8Array(32).fill(5), hpkeKey: new Uint8Array(32).fill(6) }
    const offer = encodeForTests.linkOffer({ userId: uuidToBytes(userId), deviceId: uuidToBytes(fresh.id), ...offerKeys })
    const out = new Outbox()
    await rejects(createLinkSession(w.repo, out, { userId, device: existing }, offer, new Date(w.clock.now)), 'ValidationError')
    const s = await createLinkSession(w.repo, out, { userId, device: fresh }, offer, new Date(w.clock.now))
    assert.ok(out.events.some((e) => e.t === 'DEVICE_LINK' && e.channel === `user:${userId}`))
    await postLinkMessage(w.repo, out, { userId, device: existing }, s.id, new Uint8Array([1]), new Date(w.clock.now))
    await rejects(postLinkMessage(w.repo, out, { userId, device: third }, s.id, new Uint8Array([1]), new Date(w.clock.now)), 'DeviceNotActive')
    const reply = await postLinkMessage(w.repo, out, { userId, device: fresh }, s.id, new Uint8Array([2]), new Date(w.clock.now))
    assert.equal(reply.seq, 2)
    assert.equal(out.events.at(-1)!.channel, `device:${existing.id}`)
    w.clock.now += 11 * 60_000
    await rejects(postLinkMessage(w.repo, out, { userId, device: fresh }, s.id, new Uint8Array([3]), new Date(w.clock.now)), 'LinkExpired')
  })
})
