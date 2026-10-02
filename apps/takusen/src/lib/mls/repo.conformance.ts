/**
 * One MlsRepo test suite for both implementations (repo.ts). The DS tests run
 * on InMemoryMlsRepo. This suite makes sure that drizzleMlsRepo does the same
 * thing on a real Postgres:
 *
 * - repo.in-memory.test.ts runs it on InMemoryMlsRepo (no database).
 * - repo.drizzle.pg.test.ts runs it on drizzleMlsRepo when TAKUSEN_PG_TEST_URL
 *   is set (see README.md).
 *
 * The suite uses random ids for every row, so it needs no empty database.
 * Checks on global tables (KT, sweeps) compare counts before and after.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import type { ChannelInfo, GroupKind, GroupRow, MlsRepo, OverwriteInfo } from './repo'

/** The content rows that other packages own. Each implementation seeds them its own way. */
export interface RepoFixtures {
  addUser(): Promise<string>
  /** A guild with its owner as member and an @everyone role (id = guild id). */
  addGuild(ownerId: string, everyonePermissions?: number): Promise<string>
  addRole(guildId: string, permissions: number): Promise<string>
  addGuildMember(guildId: string, userId: string, roleIds?: string[]): Promise<void>
  addChannel(c: { guildId: string | null; type: ChannelInfo['type'] }): Promise<string>
  setOverwrites(channelId: string, ows: OverwriteInfo[]): Promise<void>
  addDm(participants: string[]): Promise<string>
}

export interface RepoUnderTest {
  repo: MlsRepo
  fx: RepoFixtures
  close?(): Promise<void>
}

const bytes = (n: number) => new Uint8Array(randomBytes(n))
const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort()

export function describeMlsRepo(name: string, open: () => Promise<RepoUnderTest>, opts: { skip?: string | false } = {}): void {
  describe(`MlsRepo conformance: ${name}`, { skip: opts.skip }, () => {
    let repo: MlsRepo
    let fx: RepoFixtures
    let ut: RepoUnderTest

    before(async () => {
      ut = await open()
      repo = ut.repo
      fx = ut.fx
    })
    after(async () => {
      await ut?.close?.()
    })

    async function activeDevice(userId: string) {
      const d = await repo.insertDevice({ userId, name: 'test', platform: 'browser', clientVersion: '1.0.0' })
      return repo.updateDevice(d.id, { status: 'active', certificate: bytes(8), mlsSignatureKey: bytes(32), hpkeKey: bytes(32), dskGeneration: 1 })
    }

    async function group(kind: GroupKind = 'channel', guildId: string | null = null, channelId: string | null = null): Promise<GroupRow> {
      return repo.insertGroup({
        groupId: bytes(22),
        kind,
        scopeId: channelId ?? guildId ?? crypto.randomUUID(),
        guildId,
        channelId,
        generation: 1,
        cipherSuite: 1,
        status: 'active',
        epoch: 0,
        groupInfo: bytes(16),
        ratchetTree: bytes(16),
        historyVisibility: 'joined',
      })
    }

    test('guild permission data, overwrites, DMs and channel lookups', async () => {
      const owner = await fx.addUser()
      const member = await fx.addUser()
      const guildId = await fx.addGuild(owner, 0x400)
      const roleId = await fx.addRole(guildId, 0x800)
      await fx.addGuildMember(guildId, member, [roleId])
      const channelId = await fx.addChannel({ guildId, type: 'text' })
      await fx.addChannel({ guildId, type: 'voice' })
      const pagesId = await fx.addChannel({ guildId, type: 'pages' })
      await fx.setOverwrites(channelId, [{ id: member, type: 'member', allow: 0, deny: 0x400 }])

      const data = (await repo.getGuildPermissionData(guildId))!
      assert.deepEqual(data.guild, { id: guildId, ownerId: owner })
      assert.equal(data.roles.get(guildId)!.permissions, 0x400)
      assert.equal(data.roles.get(roleId)!.permissions, 0x800)
      assert.deepEqual(data.members.get(member), [roleId])
      assert.deepEqual(data.members.get(owner), [])
      assert.deepEqual(await repo.getChannelOverwrites(channelId), [{ id: member, type: 'member', allow: 0, deny: 0x400 }])
      assert.deepEqual((await repo.listGuildTextChannels(guildId)).map((c) => c.id).sort(), [channelId, pagesId].sort())
      assert.deepEqual(await repo.getChannel(channelId), { id: channelId, guildId, type: 'text', mlsGroupId: null })
      assert.equal(await repo.getChannel(crypto.randomUUID()), null)
      assert.deepEqual(await repo.guildIdsOfUser(member), [guildId])
      assert.equal(await repo.sharesGuildOrDm(owner, member), true)
      assert.equal(await repo.userExists(member), true)
      assert.equal(await repo.userExists(crypto.randomUUID()), false)

      const stranger = await fx.addUser()
      assert.equal(await repo.sharesGuildOrDm(owner, stranger), false)
      const dm = await fx.addDm([owner, stranger])
      assert.deepEqual((await repo.getDmParticipants(dm)).sort(), [owner, stranger].sort())
      assert.deepEqual(await repo.dmChannelIdsOfUser(stranger), [dm])
      assert.deepEqual(await repo.dmPartners(stranger), [owner])
      assert.equal(await repo.sharesGuildOrDm(owner, stranger), true)

      const g = await group('channel', guildId, channelId)
      await repo.setChannelGroup(channelId, g.groupId)
      assert.deepEqual((await repo.getChannel(channelId))!.mlsGroupId, g.groupId)
      await repo.setChannelGroup(channelId, null)
      assert.equal((await repo.getChannel(channelId))!.mlsGroupId, null)
    })

    test('devices, revocations, master keys and DSKs', async () => {
      const userId = await fx.addUser()
      const pending = await repo.insertDevice({ userId, name: 'a', platform: 'electron', clientVersion: '1' })
      assert.equal(pending.status, 'pending')
      const active = await activeDevice(userId)
      assert.equal(active.status, 'active')
      assert.deepEqual(ids(await repo.listDevices(userId)), [pending.id, active.id].sort())
      assert.equal(await repo.countLiveDevices(userId), 2)
      const at = new Date(Date.UTC(2026, 0, 1))
      await repo.updateDevice(pending.id, { status: 'revoked', revokedAt: at })
      await repo.insertRevocation({ deviceId: pending.id, userId, reason: 'signed_out', revocation: null })
      assert.equal(await repo.countLiveDevices(userId), 1)
      assert.deepEqual((await repo.listRevocations(userId)).map((r) => [r.deviceId, r.reason]), [[pending.id, 'signed_out']])
      assert.deepEqual((await repo.getDevice(pending.id))!.revokedAt, at)
      assert.equal(await repo.getDevice(crypto.randomUUID()), null)

      await repo.insertMasterKey({ userId, generation: 1, publicKey: bytes(32), record: bytes(8) })
      await repo.supersedeMasterKey(userId, at)
      await repo.insertMasterKey({ userId, generation: 2, publicKey: bytes(32), record: bytes(8) })
      const mks = await repo.listMasterKeys(userId)
      assert.deepEqual(mks.map((m) => [m.generation, m.supersededAt]), [[2, null], [1, at]])
      await repo.supersedeMasterKey(userId, at)
      await repo.restoreMasterKey(userId, 1)
      assert.deepEqual((await repo.listMasterKeys(userId)).map((m) => m.supersededAt === null), [false, true])

      await repo.insertDsk({ userId, generation: 1, masterGeneration: 1, publicKey: bytes(32), cert: bytes(8) })
      await repo.supersedeDsk(userId, at)
      await repo.insertDsk({ userId, generation: 2, masterGeneration: 1, publicKey: bytes(32), cert: bytes(8) })
      assert.deepEqual((await repo.listDsks(userId)).map((d) => [d.generation, d.supersededAt]), [[2, null], [1, at]])
    })

    test('key packages: one-time pops oldest first, then the last resort stays', async () => {
      const userId = await fx.addUser()
      const d = await activeDevice(userId)
      const expiresAt = new Date(Date.now() + 86_400_000)
      const kp = (lastResort = false, cipherSuite = 1) => ({ deviceId: d.id, userId, cipherSuite, ref: bytes(32), data: bytes(48), lastResort, expiresAt })
      const first = kp()
      const second = kp()
      assert.equal(await repo.insertKeyPackages([first]), 1)
      assert.equal(await repo.insertKeyPackages([second, { ...first, data: bytes(48) }]), 1, 'a duplicate ref is skipped')
      await repo.putLastResortKeyPackage(kp(true))
      const last = kp(true)
      await repo.putLastResortKeyPackage(last)
      await repo.insertKeyPackages([kp(false, 2)])

      const counts = (await repo.countKeyPackages(d.id)).sort((a, b) => a.cipherSuite - b.cipherSuite)
      assert.deepEqual(counts, [
        { cipherSuite: 1, count: 2, lastResort: true },
        { cipherSuite: 2, count: 1, lastResort: false },
      ])
      assert.deepEqual(await repo.devicesWithKeyPackage([d.id, crypto.randomUUID()], 1), new Set([d.id]))
      assert.deepEqual(await repo.devicesWithKeyPackage([d.id], 7), new Set())

      const c1 = await repo.claimKeyPackage(d.id, 1)
      const c2 = await repo.claimKeyPackage(d.id, 1)
      assert.equal(c1!.lastResort, false)
      assert.equal(c2!.lastResort, false)
      assert.deepEqual(new Set([Buffer.from(c1!.data).toString('hex'), Buffer.from(c2!.data).toString('hex')]), new Set([first.data, second.data].map((b) => Buffer.from(b).toString('hex'))))
      const c3 = await repo.claimKeyPackage(d.id, 1)
      const c4 = await repo.claimKeyPackage(d.id, 1)
      assert.deepEqual(c3, { data: last.data, lastResort: true })
      assert.deepEqual(c4, { data: last.data, lastResort: true }, 'the last resort is not deleted')
      assert.equal(await repo.claimKeyPackage(d.id, 9), null)

      const all = await repo.listKeyPackagesOfUser(userId)
      assert.equal(all.length, 2)
      await repo.deleteKeyPackages(all.filter((k) => k.cipherSuite === 2).map((k) => k.id))
      assert.equal((await repo.listKeyPackagesOfUser(userId)).length, 1)
      await repo.deleteDeviceKeyPackages(d.id)
      assert.deepEqual(await repo.countKeyPackages(d.id), [])
    })

    test('groups: lock, compare-and-set on the epoch, generations, epochs', async () => {
      const owner = await fx.addUser()
      const guildId = await fx.addGuild(owner)
      const channelId = await fx.addChannel({ guildId, type: 'text' })
      assert.equal(await repo.nextGroupGeneration('channel', channelId), 0)
      const g = await group('channel', guildId, channelId)
      assert.equal(await repo.nextGroupGeneration('channel', channelId), 2)
      assert.deepEqual((await repo.getGroup(g.groupId))!.groupId, g.groupId)
      assert.equal(g.latestSeq, 0)
      assert.equal(g.lastCommitRemoved, false)
      assert.deepEqual((await repo.listGroupsByGuild(guildId)).map((x) => toHex(x.groupId)), [toHex(g.groupId)])
      assert.deepEqual((await repo.listGroupsByChannel(channelId)).map((x) => toHex(x.groupId)), [toHex(g.groupId)])
      assert.ok((await repo.listActiveGroups()).some((x) => toHex(x.groupId) === toHex(g.groupId)))

      const locked = await repo.transaction((r) => r.lockGroup(g.groupId))
      assert.equal(locked!.epoch, 0)
      assert.equal(await repo.lockGroup(bytes(22)), null)
      const now = new Date(Date.UTC(2026, 1, 1))
      assert.equal(await repo.casGroupEpoch(g.groupId, 0, { epoch: 1, epochStartedAt: now, lastCommitRemoved: true }), true)
      assert.equal(await repo.casGroupEpoch(g.groupId, 0, { epoch: 2 }), false, 'the epoch moved')
      const moved = (await repo.getGroup(g.groupId))!
      assert.equal(moved.epoch, 1)
      assert.deepEqual(moved.epochStartedAt, now)
      assert.equal(moved.lastCommitRemoved, true)
      await repo.updateGroup(g.groupId, { historyVisibility: 'shared' })
      assert.equal((await repo.getGroup(g.groupId))!.historyVisibility, 'shared')

      for (const epoch of [0, 1, 2, 3]) {
        await repo.insertGroupEpoch({ groupId: g.groupId, epoch, groupInfo: bytes(8), ratchetTree: bytes(8), treeHash: bytes(32), confirmedTranscriptHash: bytes(32) })
      }
      assert.ok(await repo.getGroupEpoch(g.groupId, 2))
      assert.equal(await repo.getGroupEpoch(g.groupId, 9), null)
      await repo.pruneGroupEpochs(g.groupId, 2)
      assert.deepEqual((await repo.listGroupEpochs(g.groupId)).map((e) => e.epoch).sort(), [2, 3])
    })

    test('a throw in a transaction rolls back every write', async () => {
      const g = await group()
      await assert.rejects(
        repo.transaction(async (r) => {
          await r.updateGroup(g.groupId, { epoch: 5 })
          throw new Error('boom')
        }),
        /boom/,
      )
      assert.equal((await repo.getGroup(g.groupId))!.epoch, 0)
    })

    test('DS roster', async () => {
      const userId = await fx.addUser()
      const d1 = await activeDevice(userId)
      const d2 = await activeDevice(userId)
      const g = await group()
      const leaf = (leafIndex: number, deviceId: string) => ({ leafIndex, deviceId, userId, credentialIdentity: `${userId}:${deviceId}`, signatureKey: bytes(32) })
      await repo.replaceMembers(g.groupId, [leaf(0, d1.id), leaf(1, d2.id)])
      await repo.replaceMembers(g.groupId, [leaf(0, d1.id), leaf(2, d2.id)])
      assert.deepEqual((await repo.listMembers(g.groupId)).map((m) => m.leafIndex).sort(), [0, 2])
      assert.equal((await repo.memberByDevice(g.groupId, d2.id))!.leafIndex, 2)
      assert.equal(await repo.memberByDevice(g.groupId, crypto.randomUUID()), null)
      assert.equal((await repo.membershipsOfDevices([d1.id, d2.id])).length, 2)
      assert.equal((await repo.membershipsOfUser(userId)).length, 2)
      assert.deepEqual((await repo.groupIdsOfDevice(d1.id)).map(toHex), [toHex(g.groupId)])
    })

    test('handshakes append in seq order and move latest_seq', async () => {
      const g = await group()
      const h = (epoch: number) => ({ groupId: g.groupId, epoch, kind: 'commit' as const, senderDevice: null, message: bytes(16), treeHash: null, confirmedTranscriptHash: null })
      assert.equal(await repo.appendHandshake(h(0)), 1)
      assert.equal(await repo.appendHandshake(h(1)), 2)
      assert.equal(await repo.appendHandshake(h(2)), 3)
      assert.equal((await repo.getGroup(g.groupId))!.latestSeq, 3)
      assert.deepEqual((await repo.listHandshakes(g.groupId, 1, 10)).map((x) => x.seq), [2, 3])
      assert.deepEqual((await repo.listHandshakes(g.groupId, 0, 2)).map((x) => x.seq), [1, 2])
      assert.equal(await repo.minHandshakeSeq(g.groupId), 1)
      assert.equal(await repo.minHandshakeSeq(bytes(22)), null)
    })

    test('pending items: one open Remove per leaf, status filters, groups that need work', async () => {
      const userId = await fx.addUser()
      const d = await activeDevice(userId)
      const g = await group()
      const remove = { groupId: g.groupId, op: 'remove' as const, userId, deviceId: d.id, leafIndex: 3, keyPackage: null, joinRequestId: null, reason: 'test' }
      const r1 = await repo.insertPending(remove)
      assert.ok(r1)
      assert.equal(r1.status, 'queued')
      assert.equal(await repo.insertPending(remove), null, 'a second open Remove of the leaf is skipped')
      const add = await repo.insertPending({ ...remove, op: 'add', leafIndex: null, keyPackage: bytes(16) })
      assert.ok(add)
      assert.ok((await repo.listGroupsNeedingWork()).some((x) => toHex(x.groupId) === toHex(g.groupId)))

      await repo.updatePending(add.id, { status: 'assigned', proposal: bytes(8), proposalEpoch: 0, proposalRef: bytes(32) })
      assert.deepEqual(ids(await repo.listPending(g.groupId, ['queued'])), [r1.id])
      assert.deepEqual(ids(await repo.listPending(g.groupId, ['queued', 'assigned'])), [r1.id, add.id].sort())
      const [row] = await repo.getPendingByIds([add.id])
      assert.equal(row!.proposalEpoch, 0)
      assert.equal(row!.proposalRef!.length, 32)

      await repo.updatePending(r1.id, { status: 'rejected', reason: 'x' })
      assert.ok(await repo.insertPending(remove), 'a rejected Remove does not block a new one')
      await repo.deletePending([add.id])
      assert.deepEqual(await repo.getPendingByIds([add.id]), [])
      assert.deepEqual(await repo.getPendingByIds([]), [])
    })

    test('batches: newest first, expire, delete', async () => {
      const userId = await fx.addUser()
      const d = await activeDevice(userId)
      const g = await group()
      const b1 = await repo.insertBatch({ groupId: g.groupId, epoch: 0, deviceId: d.id, pendingIds: [], timedOutDevices: [], deadlineAt: new Date(Date.now() + 5000) })
      await new Promise((r) => setTimeout(r, 5))
      const p = crypto.randomUUID()
      const b2 = await repo.insertBatch({ groupId: g.groupId, epoch: 0, deviceId: d.id, pendingIds: [p], timedOutDevices: [d.id], deadlineAt: new Date(Date.now() + 5000) })
      assert.deepEqual((await repo.listBatchesOfGroup(g.groupId)).map((b) => b.id), [b2.id, b1.id])
      const got = (await repo.getBatch(b2.id))!
      assert.deepEqual(got.pendingIds, [p])
      assert.deepEqual(got.timedOutDevices, [d.id])
      const at = new Date(Date.UTC(2026, 2, 1))
      await repo.expireBatch(b1.id, at)
      assert.deepEqual((await repo.getBatch(b1.id))!.deadlineAt, at)
      await repo.deleteBatch(b1.id)
      assert.equal(await repo.getBatch(b1.id), null)
      await repo.deleteBatchesOfGroup(g.groupId)
      assert.deepEqual(await repo.listBatchesOfGroup(g.groupId), [])
    })

    test('join requests: open statuses and the retire cleanup', async () => {
      const userId = await fx.addUser()
      const d = await activeDevice(userId)
      const g = await group()
      const jr = await repo.insertJoinRequest({ groupId: g.groupId, deviceId: d.id, userId, keyPackage: bytes(16), status: 'queued', reason: null })
      const done = await repo.insertJoinRequest({ groupId: g.groupId, deviceId: d.id, userId, keyPackage: bytes(16), status: 'rejected', reason: 'no_key_package' })
      assert.deepEqual(ids(await repo.listOpenJoinRequests(g.groupId)), [jr.id])
      await repo.updateJoinRequest(jr.id, { status: 'waiting', reason: 'no_member_online' }, new Date())
      assert.deepEqual((await repo.getJoinRequest(jr.id))!.status, 'waiting')
      assert.deepEqual(ids(await repo.listOpenJoinRequests(g.groupId)), [jr.id])
      await repo.insertPending({ groupId: g.groupId, op: 'add', userId, deviceId: d.id, leafIndex: null, keyPackage: bytes(8), joinRequestId: jr.id, reason: 'x' })
      await repo.insertBatch({ groupId: g.groupId, epoch: 0, deviceId: d.id, pendingIds: [], timedOutDevices: [], deadlineAt: new Date() })
      await repo.deleteGroupWork(g.groupId)
      assert.deepEqual(await repo.listPending(g.groupId, ['queued', 'assigned', 'rejected']), [])
      assert.deepEqual(await repo.listBatchesOfGroup(g.groupId), [])
      assert.equal(await repo.getJoinRequest(jr.id), null)
      assert.equal(await repo.getJoinRequest(done.id), null)
    })

    test('device inbox: seq order, expiry, byte count, ack', async () => {
      const userId = await fx.addUser()
      const d = await activeDevice(userId)
      const now = new Date()
      const later = new Date(now.getTime() + 60_000)
      const past = new Date(now.getTime() - 60_000)
      const a = await repo.insertInboxItem({ deviceId: d.id, kind: 'welcome', senderDevice: null, body: bytes(10), size: 10, expiresAt: later })
      const b = await repo.insertInboxItem({ deviceId: d.id, kind: 'history_keys', senderDevice: d.id, body: bytes(20), size: 20, expiresAt: later })
      await repo.insertInboxItem({ deviceId: d.id, kind: 'welcome', senderDevice: null, body: bytes(40), size: 40, expiresAt: past })
      assert.ok(b.seq > a.seq)
      assert.deepEqual((await repo.listInbox(d.id, 0, 10, now)).map((i) => i.id), [a.id, b.id])
      assert.deepEqual((await repo.listInbox(d.id, a.seq, 10, now)).map((i) => i.id), [b.id])
      assert.deepEqual((await repo.listInbox(d.id, 0, 1, now)).map((i) => i.id), [a.id])
      assert.equal(await repo.inboxBytes(d.id, now), 30)
      assert.ok((await repo.deleteExpiredInbox(now)) >= 1)
      assert.equal(await repo.deleteInboxItem(d.id, a.id), true)
      assert.equal(await repo.deleteInboxItem(d.id, a.id), false)
      const other = await activeDevice(userId)
      assert.equal(await repo.deleteInboxItem(other.id, b.id), false, 'another device cannot ack the item')
    })

    test('backups and history bundles', async () => {
      const userId = await fx.addUser()
      const d = await activeDevice(userId)
      const g = await group()
      await repo.putIdentityBackup({ userId, kind: 'identity', keyId: bytes(16), groupId: null, epochFrom: null, epochTo: null, blob: bytes(10), size: 10 })
      await repo.putIdentityBackup({ userId, kind: 'identity', keyId: bytes(16), groupId: null, epochFrom: null, epochTo: null, blob: bytes(12), size: 12 })
      const hid = await repo.insertBackup({ userId, kind: 'history', keyId: bytes(16), groupId: g.groupId, epochFrom: 0, epochTo: 3, blob: bytes(30), size: 30 })
      const list = await repo.listBackups(userId)
      assert.deepEqual(list.map((b) => b.kind).sort(), ['history', 'identity'])
      assert.equal('blob' in list[0]!, false, 'the list has no blobs')
      assert.equal(await repo.backupBytes(userId), 42)
      assert.equal((await repo.getBackup(userId, hid))!.epochTo, 3)
      assert.equal(await repo.getBackup(await fx.addUser(), hid), null)
      await repo.deleteBackups(userId)
      assert.deepEqual(await repo.listBackups(userId), [])

      const bundle = { groupId: g.groupId, epoch: 2, senderDevice: d.id, blob: bytes(8) }
      assert.equal(await repo.insertHistoryBundle(bundle), true)
      assert.equal(await repo.insertHistoryBundle(bundle), false)
      assert.equal((await repo.listHistoryBundles(g.groupId, 2)).length, 1)
      assert.deepEqual(await repo.historyBundleEpochs(g.groupId, [1, 2, 3]), new Set([2]))
    })

    test('device linking: sessions and ordered messages', async () => {
      const userId = await fx.addUser()
      const existing = await activeDevice(userId)
      const fresh = await repo.insertDevice({ userId, name: 'new', platform: 'browser', clientVersion: '1' })
      const now = new Date()
      const s = await repo.insertLinkSession({ userId, newDeviceId: fresh.id, offer: bytes(16), expiresAt: new Date(now.getTime() + 60_000) })
      assert.equal((await repo.getLinkSession(s.id))!.newDeviceId, fresh.id)
      assert.deepEqual(ids(await repo.listLinkSessions(userId, now)), [s.id])
      assert.equal((await repo.openLinkSessionOfDevice(fresh.id, now))!.id, s.id)
      const m1 = await repo.insertLinkMessage({ sessionId: s.id, fromDevice: existing.id, body: bytes(8) })
      const m2 = await repo.insertLinkMessage({ sessionId: s.id, fromDevice: fresh.id, body: bytes(8) })
      assert.equal(m2, m1 + 1)
      assert.deepEqual((await repo.listLinkMessages(s.id, m1)).map((m) => m.seq), [m2])
      assert.equal(await repo.deleteExpiredLinkSessions(new Date(now.getTime() + 120_000)) >= 1, true)
      assert.equal(await repo.getLinkSession(s.id), null)
    })

    test('key transparency: append at the end, ranges and heads', async () => {
      const userId = await fx.addUser()
      const size = await repo.ktSize()
      const entry = () => ({ userId, type: 1, leafHash: bytes(32), entry: bytes(32) })
      const i1 = await repo.appendKtEntry(entry())
      const i2 = await repo.appendKtEntry(entry())
      assert.equal(i1, size)
      assert.equal(i2, size + 1)
      assert.equal(await repo.ktSize(), size + 2)
      assert.equal((await repo.ktLeafHashes(size + 2)).length, size + 2)
      assert.deepEqual((await repo.listKtEntriesRange(i1, i2 + 1)).map((e) => e.idx), [i1, i2])
      assert.deepEqual((await repo.listKtEntriesOfUser(userId, -1, 10)).map((e) => e.idx), [i1, i2])
    })
  })
}

function toHex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}
