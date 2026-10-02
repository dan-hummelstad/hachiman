/**
 * Drizzle implementation of MlsRepo (repo.ts). The in-memory implementation
 * (repo.in-memory.ts) follows it method by method: change both together.
 */
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'

import { db, type Database, type Tx } from '@/db/client'
import {
  channels,
  deviceInbox,
  deviceLinkMessages,
  deviceLinkSessions,
  deviceRevocations,
  devices,
  deviceSigningKeys,
  dmParticipants,
  guildMembers,
  guilds,
  historyBundles,
  keyBackups,
  keyPackages,
  ktEntries,
  ktTreeHeads,
  masterKeys,
  memberRoles,
  messages,
  mlsBatches,
  mlsGroupEpochs,
  mlsGroupMembers,
  mlsGroups,
  mlsHandshakes,
  mlsJoinRequests,
  mlsPending,
  permissionOverwrites,
  roles,
  users,
} from '@/db/schema'

import type { GuildPermissionData, MlsRepo, NewKeyPackage } from './repo'

/** A Drizzle handle: the pool or an open transaction. */
export type Executor = Database | Tx

/** Transaction-scoped advisory lock id for KT appends (§12.14). "KT" in ASCII. */
export const KT_LOCK_ID = 0x4b54

const OPEN_JOIN = ['queued', 'waiting', 'external_commit'] as const

function isTx(x: Executor): x is Tx {
  return x !== db
}

export function drizzleMlsRepo(x: Executor = db): MlsRepo {
  const repo: MlsRepo = {
    async transaction(fn) {
      // A nested call inside a transaction opens a savepoint.
      return isTx(x) ? x.transaction((tx) => fn(drizzleMlsRepo(tx))) : db.transaction((tx) => fn(drizzleMlsRepo(tx)))
    },

    // MARK: guild, channel and DM data

    async getChannel(channelId) {
      const [c] = await x
        .select({ id: channels.id, guildId: channels.guildId, type: channels.type, mlsGroupId: channels.mlsGroupId })
        .from(channels)
        .where(eq(channels.id, channelId))
        .limit(1)
      return c ?? null
    },
    async listGuildTextChannels(guildId) {
      return x
        .select({ id: channels.id, guildId: channels.guildId, type: channels.type, mlsGroupId: channels.mlsGroupId })
        .from(channels)
        .where(and(eq(channels.guildId, guildId), eq(channels.type, 'text')))
    },
    async getGuildPermissionData(guildId): Promise<GuildPermissionData | null> {
      const [guild] = await x.select({ id: guilds.id, ownerId: guilds.ownerId }).from(guilds).where(eq(guilds.id, guildId)).limit(1)
      if (!guild) return null
      const [roleRows, memberRows, roleLinks] = await Promise.all([
        x.select({ id: roles.id, permissions: roles.permissions }).from(roles).where(eq(roles.guildId, guildId)),
        x.select({ userId: guildMembers.userId }).from(guildMembers).where(eq(guildMembers.guildId, guildId)),
        x.select({ userId: memberRoles.userId, roleId: memberRoles.roleId }).from(memberRoles).where(eq(memberRoles.guildId, guildId)),
      ])
      const members = new Map<string, string[]>(memberRows.map((m) => [m.userId, []]))
      for (const l of roleLinks) members.get(l.userId)?.push(l.roleId)
      return { guild, roles: new Map(roleRows.map((r) => [r.id, r])), members }
    },
    async getChannelOverwrites(channelId) {
      const rows = await x.select().from(permissionOverwrites).where(eq(permissionOverwrites.channelId, channelId))
      return rows.map((o) => ({ id: o.targetId, type: o.targetType, allow: o.allow, deny: o.deny }))
    },
    async getDmParticipants(channelId) {
      const rows = await x.select({ userId: dmParticipants.userId }).from(dmParticipants).where(eq(dmParticipants.channelId, channelId))
      return rows.map((r) => r.userId)
    },
    async setChannelGroup(channelId, groupId) {
      await x.update(channels).set({ mlsGroupId: groupId }).where(eq(channels.id, channelId))
    },
    async guildIdsOfUser(userId) {
      const rows = await x.select({ guildId: guildMembers.guildId }).from(guildMembers).where(eq(guildMembers.userId, userId))
      return rows.map((r) => r.guildId)
    },
    async dmChannelIdsOfUser(userId) {
      const rows = await x.select({ channelId: dmParticipants.channelId }).from(dmParticipants).where(eq(dmParticipants.userId, userId))
      return rows.map((r) => r.channelId)
    },
    async dmPartners(userId) {
      const mine = x.select({ channelId: dmParticipants.channelId }).from(dmParticipants).where(eq(dmParticipants.userId, userId))
      const rows = await x
        .selectDistinct({ userId: dmParticipants.userId })
        .from(dmParticipants)
        .where(and(inArray(dmParticipants.channelId, mine), ne(dmParticipants.userId, userId)))
      return rows.map((r) => r.userId)
    },
    async sharesGuildOrDm(a, b) {
      const rows = await x.execute<{ ok: number }>(sql`
        select 1 as ok from ${guildMembers} g1 join ${guildMembers} g2 on g1.guild_id = g2.guild_id
          where g1.user_id = ${a} and g2.user_id = ${b}
        union all
        select 1 as ok from ${dmParticipants} d1 join ${dmParticipants} d2 on d1.channel_id = d2.channel_id
          where d1.user_id = ${a} and d2.user_id = ${b}
        limit 1`)
      return rows.length > 0
    },
    async userExists(userId) {
      const [u] = await x.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
      return !!u
    },
    async messageClientMsgIdExists(channelId, clientMsgId) {
      const [m] = await x
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.channelId, channelId), eq(messages.clientMsgId, clientMsgId)))
        .limit(1)
      return !!m
    },

    // MARK: devices

    async insertDevice(d) {
      const [row] = await x.insert(devices).values(d).returning()
      return row!
    },
    async getDevice(id) {
      const [row] = await x.select().from(devices).where(eq(devices.id, id)).limit(1)
      return row ?? null
    },
    async listDevices(userId) {
      return x.select().from(devices).where(eq(devices.userId, userId)).orderBy(asc(devices.createdAt))
    },
    async countLiveDevices(userId) {
      const [r] = await x
        .select({ n: sql<number>`count(*)::int` })
        .from(devices)
        .where(and(eq(devices.userId, userId), ne(devices.status, 'revoked')))
      return r?.n ?? 0
    },
    async updateDevice(id, patch) {
      const [row] = await x.update(devices).set(patch).where(eq(devices.id, id)).returning()
      if (!row) throw new Error(`no device ${id}`)
      return row
    },
    async insertRevocation(r) {
      await x.insert(deviceRevocations).values(r).onConflictDoNothing()
    },
    async listRevocations(userId) {
      return x.select().from(deviceRevocations).where(eq(deviceRevocations.userId, userId))
    },

    // MARK: master keys and device-signing keys

    async listMasterKeys(userId) {
      return x.select().from(masterKeys).where(eq(masterKeys.userId, userId)).orderBy(desc(masterKeys.generation))
    },
    async insertMasterKey(r) {
      await x.insert(masterKeys).values(r)
    },
    async supersedeMasterKey(userId, at) {
      await x.update(masterKeys).set({ supersededAt: at }).where(and(eq(masterKeys.userId, userId), isNull(masterKeys.supersededAt)))
    },
    async restoreMasterKey(userId, generation) {
      await x.update(masterKeys).set({ supersededAt: null }).where(and(eq(masterKeys.userId, userId), eq(masterKeys.generation, generation)))
    },
    async listDsks(userId) {
      return x.select().from(deviceSigningKeys).where(eq(deviceSigningKeys.userId, userId)).orderBy(desc(deviceSigningKeys.generation))
    },
    async insertDsk(r) {
      await x.insert(deviceSigningKeys).values(r)
    },
    async supersedeDsk(userId, at) {
      await x
        .update(deviceSigningKeys)
        .set({ supersededAt: at })
        .where(and(eq(deviceSigningKeys.userId, userId), isNull(deviceSigningKeys.supersededAt)))
    },

    // MARK: key packages

    async insertKeyPackages(rows: NewKeyPackage[]) {
      if (rows.length === 0) return 0
      const out = await x.insert(keyPackages).values(rows).onConflictDoNothing({ target: keyPackages.ref }).returning({ id: keyPackages.id })
      return out.length
    },
    async putLastResortKeyPackage(row) {
      await x
        .delete(keyPackages)
        .where(
          or(
            and(eq(keyPackages.deviceId, row.deviceId), eq(keyPackages.cipherSuite, row.cipherSuite), eq(keyPackages.lastResort, true)),
            eq(keyPackages.ref, row.ref),
          ),
        )
      await x.insert(keyPackages).values({ ...row, lastResort: true })
    },
    async countKeyPackages(deviceId) {
      const rows = await x
        .select({
          cipherSuite: keyPackages.cipherSuite,
          count: sql<number>`(count(*) filter (where not ${keyPackages.lastResort}))::int`,
          lastResort: sql<boolean>`bool_or(${keyPackages.lastResort})`,
        })
        .from(keyPackages)
        .where(eq(keyPackages.deviceId, deviceId))
        .groupBy(keyPackages.cipherSuite)
        .orderBy(asc(keyPackages.cipherSuite))
      return rows
    },
    async claimKeyPackage(deviceId, cipherSuite) {
      // §12.7.2: one atomic pop, SKIP LOCKED so concurrent claims take different rows.
      const popped = await x.execute<{ data: Buffer }>(sql`
        delete from ${keyPackages} where id = (
          select id from ${keyPackages}
          where device_id = ${deviceId} and cipher_suite = ${cipherSuite} and not last_resort
          order by created_at limit 1 for update skip locked
        ) returning data`)
      const first = popped[0]
      if (first) return { data: new Uint8Array(first.data), lastResort: false }
      const [lr] = await x
        .select({ data: keyPackages.data })
        .from(keyPackages)
        .where(and(eq(keyPackages.deviceId, deviceId), eq(keyPackages.cipherSuite, cipherSuite), eq(keyPackages.lastResort, true)))
        .limit(1)
      return lr ? { data: lr.data, lastResort: true } : null
    },
    async listKeyPackagesOfUser(userId) {
      return x
        .select({ id: keyPackages.id, deviceId: keyPackages.deviceId, cipherSuite: keyPackages.cipherSuite, data: keyPackages.data })
        .from(keyPackages)
        .where(eq(keyPackages.userId, userId))
    },
    async deleteKeyPackages(ids) {
      if (ids.length) await x.delete(keyPackages).where(inArray(keyPackages.id, ids))
    },
    async deleteDeviceKeyPackages(deviceId) {
      await x.delete(keyPackages).where(eq(keyPackages.deviceId, deviceId))
    },
    async devicesWithKeyPackage(deviceIds, cipherSuite) {
      if (deviceIds.length === 0) return new Set()
      const rows = await x
        .selectDistinct({ deviceId: keyPackages.deviceId })
        .from(keyPackages)
        .where(and(inArray(keyPackages.deviceId, deviceIds), eq(keyPackages.cipherSuite, cipherSuite)))
      return new Set(rows.map((r) => r.deviceId))
    },

    // MARK: groups

    async insertGroup(g) {
      const [row] = await x.insert(mlsGroups).values(g).returning()
      return row!
    },
    async getGroup(groupId) {
      const [row] = await x.select().from(mlsGroups).where(eq(mlsGroups.groupId, groupId)).limit(1)
      return row ?? null
    },
    async lockGroup(groupId) {
      const [row] = await x.select().from(mlsGroups).where(eq(mlsGroups.groupId, groupId)).limit(1).for('update')
      return row ?? null
    },
    async nextGroupGeneration(kind, scopeId) {
      const [r] = await x
        .select({ max: sql<number | null>`max(${mlsGroups.generation})` })
        .from(mlsGroups)
        .where(and(eq(mlsGroups.kind, kind), eq(mlsGroups.scopeId, scopeId)))
      return r?.max === null || r?.max === undefined ? 0 : Number(r.max) + 1
    },
    async listGroupsByGuild(guildId) {
      return x.select().from(mlsGroups).where(eq(mlsGroups.guildId, guildId))
    },
    async listGroupsByChannel(channelId) {
      return x.select().from(mlsGroups).where(eq(mlsGroups.channelId, channelId))
    },
    async listGroupsNeedingWork() {
      const open = x.selectDistinct({ groupId: mlsPending.groupId }).from(mlsPending).where(ne(mlsPending.status, 'rejected'))
      return x
        .select()
        .from(mlsGroups)
        .where(or(eq(mlsGroups.status, 'pending'), and(eq(mlsGroups.status, 'active'), inArray(mlsGroups.groupId, open))))
    },
    async listActiveGroups() {
      return x.select().from(mlsGroups).where(eq(mlsGroups.status, 'active'))
    },
    async updateGroup(groupId, patch) {
      await x.update(mlsGroups).set(patch).where(eq(mlsGroups.groupId, groupId))
    },
    async casGroupEpoch(groupId, expectedEpoch, patch) {
      const rows = await x
        .update(mlsGroups)
        .set(patch)
        .where(and(eq(mlsGroups.groupId, groupId), eq(mlsGroups.epoch, expectedEpoch)))
        .returning({ groupId: mlsGroups.groupId })
      return rows.length === 1
    },
    async deleteGroupWork(groupId) {
      await x.delete(mlsPending).where(eq(mlsPending.groupId, groupId))
      await x.delete(mlsBatches).where(eq(mlsBatches.groupId, groupId))
      await x.delete(mlsJoinRequests).where(eq(mlsJoinRequests.groupId, groupId))
    },
    async insertGroupEpoch(r) {
      await x
        .insert(mlsGroupEpochs)
        .values(r)
        .onConflictDoUpdate({
          target: [mlsGroupEpochs.groupId, mlsGroupEpochs.epoch],
          set: { groupInfo: r.groupInfo, ratchetTree: r.ratchetTree, treeHash: r.treeHash, confirmedTranscriptHash: r.confirmedTranscriptHash },
        })
    },
    async getGroupEpoch(groupId, epoch) {
      const [row] = await x
        .select()
        .from(mlsGroupEpochs)
        .where(and(eq(mlsGroupEpochs.groupId, groupId), eq(mlsGroupEpochs.epoch, epoch)))
        .limit(1)
      return row ?? null
    },
    async listGroupEpochs(groupId) {
      return x.select().from(mlsGroupEpochs).where(eq(mlsGroupEpochs.groupId, groupId)).orderBy(asc(mlsGroupEpochs.epoch))
    },
    async pruneGroupEpochs(groupId, minEpoch) {
      await x.delete(mlsGroupEpochs).where(and(eq(mlsGroupEpochs.groupId, groupId), lt(mlsGroupEpochs.epoch, minEpoch)))
    },
    async pruneAllGroupEpochs(keep) {
      const rows = await x.execute(sql`
        delete from ${mlsGroupEpochs} e using (
          select group_id, max(epoch) as top from ${mlsGroupEpochs} group by group_id
        ) m where e.group_id = m.group_id and e.epoch <= m.top - ${keep}
        returning e.epoch`)
      return rows.length
    },

    // MARK: DS roster

    async listMembers(groupId) {
      return x.select().from(mlsGroupMembers).where(eq(mlsGroupMembers.groupId, groupId)).orderBy(asc(mlsGroupMembers.leafIndex))
    },
    async replaceMembers(groupId, rows) {
      await x.delete(mlsGroupMembers).where(eq(mlsGroupMembers.groupId, groupId))
      if (rows.length) await x.insert(mlsGroupMembers).values(rows.map((r) => ({ ...r, groupId })))
    },
    async memberByDevice(groupId, deviceId) {
      const [row] = await x
        .select()
        .from(mlsGroupMembers)
        .where(and(eq(mlsGroupMembers.groupId, groupId), eq(mlsGroupMembers.deviceId, deviceId)))
        .limit(1)
      return row ?? null
    },
    async membershipsOfDevices(deviceIds) {
      if (deviceIds.length === 0) return []
      return x.select().from(mlsGroupMembers).where(inArray(mlsGroupMembers.deviceId, deviceIds))
    },
    async membershipsOfUser(userId) {
      return x.select().from(mlsGroupMembers).where(eq(mlsGroupMembers.userId, userId))
    },
    async groupIdsOfDevice(deviceId) {
      const rows = await x.select({ groupId: mlsGroupMembers.groupId }).from(mlsGroupMembers).where(eq(mlsGroupMembers.deviceId, deviceId))
      return rows.map((r) => r.groupId)
    },

    // MARK: handshakes

    async appendHandshake(h) {
      const [g] = await x
        .update(mlsGroups)
        .set({ latestSeq: sql`${mlsGroups.latestSeq} + 1` })
        .where(eq(mlsGroups.groupId, h.groupId))
        .returning({ seq: mlsGroups.latestSeq })
      if (!g) throw new Error('no group')
      await x.insert(mlsHandshakes).values({ ...h, seq: g.seq })
      return g.seq
    },
    async listHandshakes(groupId, after, limit) {
      return x
        .select()
        .from(mlsHandshakes)
        .where(and(eq(mlsHandshakes.groupId, groupId), gt(mlsHandshakes.seq, after)))
        .orderBy(asc(mlsHandshakes.seq))
        .limit(limit)
    },
    async minHandshakeSeq(groupId) {
      const [r] = await x
        .select({ min: sql<number | null>`min(${mlsHandshakes.seq})` })
        .from(mlsHandshakes)
        .where(eq(mlsHandshakes.groupId, groupId))
      return r?.min === null || r?.min === undefined ? null : Number(r.min)
    },
    async deleteHandshakesBefore(at) {
      const rows = await x.delete(mlsHandshakes).where(lt(mlsHandshakes.createdAt, at)).returning({ seq: mlsHandshakes.seq })
      return rows.length
    },

    // MARK: pending

    async insertPending(p) {
      const rows = await x.insert(mlsPending).values(p).onConflictDoNothing().returning()
      return rows[0] ?? null
    },
    async listPending(groupId, statuses) {
      return x
        .select()
        .from(mlsPending)
        .where(and(eq(mlsPending.groupId, groupId), inArray(mlsPending.status, statuses)))
        .orderBy(asc(mlsPending.createdAt))
    },
    async getPendingByIds(ids) {
      if (ids.length === 0) return []
      return x.select().from(mlsPending).where(inArray(mlsPending.id, ids))
    },
    async updatePending(id, patch) {
      await x.update(mlsPending).set(patch).where(eq(mlsPending.id, id))
    },
    async deletePending(ids) {
      if (ids.length) await x.delete(mlsPending).where(inArray(mlsPending.id, ids))
    },

    // MARK: batches

    async insertBatch(b) {
      const [row] = await x.insert(mlsBatches).values(b).returning()
      return row!
    },
    async getBatch(id) {
      const [row] = await x.select().from(mlsBatches).where(eq(mlsBatches.id, id)).limit(1)
      return row ?? null
    },
    async listBatchesOfGroup(groupId) {
      return x.select().from(mlsBatches).where(eq(mlsBatches.groupId, groupId)).orderBy(desc(mlsBatches.createdAt))
    },
    async expireBatch(id, at) {
      await x.update(mlsBatches).set({ deadlineAt: at }).where(eq(mlsBatches.id, id))
    },
    async deleteBatch(id) {
      await x.delete(mlsBatches).where(eq(mlsBatches.id, id))
    },
    async deleteBatchesOfGroup(groupId) {
      await x.delete(mlsBatches).where(eq(mlsBatches.groupId, groupId))
    },

    // MARK: join requests

    async insertJoinRequest(j) {
      const [row] = await x.insert(mlsJoinRequests).values(j).returning()
      return row!
    },
    async getJoinRequest(id) {
      const [row] = await x.select().from(mlsJoinRequests).where(eq(mlsJoinRequests.id, id)).limit(1)
      return row ?? null
    },
    async updateJoinRequest(id, patch, at) {
      await x.update(mlsJoinRequests).set({ ...patch, updatedAt: at }).where(eq(mlsJoinRequests.id, id))
    },
    async listOpenJoinRequests(groupId) {
      return x
        .select()
        .from(mlsJoinRequests)
        .where(and(eq(mlsJoinRequests.groupId, groupId), inArray(mlsJoinRequests.status, [...OPEN_JOIN])))
    },
    async deleteJoinRequestsBefore(at) {
      const rows = await x.delete(mlsJoinRequests).where(lt(mlsJoinRequests.createdAt, at)).returning({ id: mlsJoinRequests.id })
      return rows.length
    },

    // MARK: device inbox

    async insertInboxItem(i) {
      const [row] = await x.insert(deviceInbox).values(i).returning()
      return row!
    },
    async listInbox(deviceId, after, limit, now) {
      return x
        .select()
        .from(deviceInbox)
        .where(and(eq(deviceInbox.deviceId, deviceId), gt(deviceInbox.seq, after), gt(deviceInbox.expiresAt, now)))
        .orderBy(asc(deviceInbox.seq))
        .limit(limit)
    },
    async deleteInboxItem(deviceId, id) {
      const rows = await x
        .delete(deviceInbox)
        .where(and(eq(deviceInbox.deviceId, deviceId), eq(deviceInbox.id, id)))
        .returning({ id: deviceInbox.id })
      return rows.length > 0
    },
    async inboxBytes(deviceId, now) {
      const [r] = await x
        .select({ n: sql<number>`coalesce(sum(${deviceInbox.size}), 0)::bigint` })
        .from(deviceInbox)
        .where(and(eq(deviceInbox.deviceId, deviceId), gt(deviceInbox.expiresAt, now)))
      return Number(r?.n ?? 0)
    },
    async deleteExpiredInbox(now) {
      const rows = await x.delete(deviceInbox).where(lte(deviceInbox.expiresAt, now)).returning({ id: deviceInbox.id })
      return rows.length
    },

    // MARK: backups and history bundles

    async listBackups(userId) {
      return x
        .select({
          id: keyBackups.id,
          userId: keyBackups.userId,
          keyId: keyBackups.keyId,
          kind: keyBackups.kind,
          groupId: keyBackups.groupId,
          epochFrom: keyBackups.epochFrom,
          epochTo: keyBackups.epochTo,
          size: keyBackups.size,
          createdAt: keyBackups.createdAt,
        })
        .from(keyBackups)
        .where(eq(keyBackups.userId, userId))
        .orderBy(asc(keyBackups.createdAt))
    },
    async getBackup(userId, id) {
      const [row] = await x
        .select()
        .from(keyBackups)
        .where(and(eq(keyBackups.userId, userId), eq(keyBackups.id, id)))
        .limit(1)
      return row ?? null
    },
    async putIdentityBackup(b) {
      await x.delete(keyBackups).where(and(eq(keyBackups.userId, b.userId), eq(keyBackups.kind, 'identity')))
      await x.insert(keyBackups).values(b)
    },
    async insertBackup(b) {
      const [row] = await x.insert(keyBackups).values(b).returning({ id: keyBackups.id })
      return row!.id
    },
    async deleteBackups(userId) {
      await x.delete(keyBackups).where(eq(keyBackups.userId, userId))
    },
    async backupBytes(userId) {
      const [r] = await x
        .select({ n: sql<number>`coalesce(sum(${keyBackups.size}), 0)::bigint` })
        .from(keyBackups)
        .where(eq(keyBackups.userId, userId))
      return Number(r?.n ?? 0)
    },
    async insertHistoryBundle(b) {
      const rows = await x.insert(historyBundles).values(b).onConflictDoNothing().returning({ id: historyBundles.id })
      return rows.length > 0
    },
    async listHistoryBundles(groupId, epoch) {
      return x
        .select()
        .from(historyBundles)
        .where(and(eq(historyBundles.groupId, groupId), eq(historyBundles.epoch, epoch)))
        .orderBy(asc(historyBundles.createdAt))
    },
    async historyBundleEpochs(groupId, epochs) {
      if (epochs.length === 0) return new Set()
      const rows = await x
        .selectDistinct({ epoch: historyBundles.epoch })
        .from(historyBundles)
        .where(and(eq(historyBundles.groupId, groupId), inArray(historyBundles.epoch, epochs)))
      return new Set(rows.map((r) => r.epoch))
    },

    // MARK: device linking

    async insertLinkSession(s) {
      const [row] = await x.insert(deviceLinkSessions).values(s).returning()
      return row!
    },
    async getLinkSession(id) {
      const [row] = await x.select().from(deviceLinkSessions).where(eq(deviceLinkSessions.id, id)).limit(1)
      return row ?? null
    },
    async listLinkSessions(userId, now) {
      return x
        .select()
        .from(deviceLinkSessions)
        .where(and(eq(deviceLinkSessions.userId, userId), gt(deviceLinkSessions.expiresAt, now)))
        .orderBy(asc(deviceLinkSessions.createdAt))
    },
    async openLinkSessionOfDevice(newDeviceId, now) {
      const [row] = await x
        .select()
        .from(deviceLinkSessions)
        .where(and(eq(deviceLinkSessions.newDeviceId, newDeviceId), gt(deviceLinkSessions.expiresAt, now)))
        .orderBy(desc(deviceLinkSessions.createdAt))
        .limit(1)
      return row ?? null
    },
    async deleteLinkSession(id) {
      await x.delete(deviceLinkSessions).where(eq(deviceLinkSessions.id, id))
    },
    async deleteExpiredLinkSessions(now) {
      const rows = await x.delete(deviceLinkSessions).where(lte(deviceLinkSessions.expiresAt, now)).returning({ id: deviceLinkSessions.id })
      return rows.length
    },
    async insertLinkMessage(m) {
      // Lock the session row so two posts cannot take the same seq.
      await x.select({ id: deviceLinkSessions.id }).from(deviceLinkSessions).where(eq(deviceLinkSessions.id, m.sessionId)).for('update')
      const [r] = await x
        .select({ max: sql<number | null>`max(${deviceLinkMessages.seq})` })
        .from(deviceLinkMessages)
        .where(eq(deviceLinkMessages.sessionId, m.sessionId))
      const seq = (r?.max === null || r?.max === undefined ? 0 : Number(r.max)) + 1
      await x.insert(deviceLinkMessages).values({ ...m, seq })
      return seq
    },
    async listLinkMessages(sessionId, after) {
      return x
        .select()
        .from(deviceLinkMessages)
        .where(and(eq(deviceLinkMessages.sessionId, sessionId), gt(deviceLinkMessages.seq, after)))
        .orderBy(asc(deviceLinkMessages.seq))
    },

    // MARK: key transparency

    async appendKtEntry(e) {
      // §12.14: the transaction lock serializes appends, so indexes have no gaps and no repeats.
      await x.execute(sql`select pg_advisory_xact_lock(${KT_LOCK_ID})`)
      const [r] = await x.select({ max: sql<number | null>`max(${ktEntries.idx})` }).from(ktEntries)
      const idx = r?.max === null || r?.max === undefined ? 0 : Number(r.max) + 1
      await x.insert(ktEntries).values({ ...e, idx })
      return idx
    },
    async ktSize() {
      const [r] = await x.select({ max: sql<number | null>`max(${ktEntries.idx})` }).from(ktEntries)
      return r?.max === null || r?.max === undefined ? 0 : Number(r.max) + 1
    },
    async ktLeafHashes(treeSize) {
      const rows = await x.select({ leafHash: ktEntries.leafHash }).from(ktEntries).where(lt(ktEntries.idx, treeSize)).orderBy(asc(ktEntries.idx))
      return rows.map((r) => r.leafHash)
    },
    async listKtEntriesOfUser(userId, after, limit) {
      return x
        .select()
        .from(ktEntries)
        .where(and(eq(ktEntries.userId, userId), gt(ktEntries.idx, after)))
        .orderBy(asc(ktEntries.idx))
        .limit(limit)
    },
    async listKtEntriesRange(start, end) {
      return x
        .select()
        .from(ktEntries)
        .where(and(gte(ktEntries.idx, start), lt(ktEntries.idx, end)))
        .orderBy(asc(ktEntries.idx))
    },
    async latestKtHead() {
      const [row] = await x.select().from(ktTreeHeads).orderBy(desc(ktTreeHeads.treeSize)).limit(1)
      return row ?? null
    },
    async insertKtHead(h) {
      await x.insert(ktTreeHeads).values(h)
    },
    async markKtHeadPublished(treeSize, at) {
      await x.update(ktTreeHeads).set({ publishedAt: at }).where(eq(ktTreeHeads.treeSize, treeSize))
    },
  }
  return repo
}
