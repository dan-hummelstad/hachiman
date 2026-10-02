/**
 * The batch scheduler core (docs/gateway-protocol.md §12.7.5, §12.7.7). The
 * gRPC process runs it on a timer and on each `takusen:mls_wakeup`
 * (src/grpc/mls-scheduler.ts). The decline route runs one group at once.
 *
 * Takusen never commits. It picks one online member device, gives it the
 * stored proposals and the Adds by value, and waits. On a timeout or a
 * decline it gives the batch to the next device.
 */
import { ApiError } from '@/lib/errors'

import { toB64 } from './bytes'
import { BATCH_TIMEOUT_COOLDOWN_MS } from './config'
import type { DsDeps, LightDeps } from './context'
import { BATCH_MAX_ADDS, type CipherSuiteId, type WireBatchAssign } from './crypto'
import type { Outbox } from './events'
import { signPendingProposals } from './proposals'
import { readersOfGroup } from './readers'
import type { BatchRow, DeviceRow, GroupRow, MlsRepo, PendingRow } from './repo'
import { activeDevicesOf } from './groups'

function deadline(deps: LightDeps): Date {
  return new Date(deps.now().getTime() + deps.config.batchTimeoutMs)
}

/** Devices whose batch on this group expired in the last 60 s (§12.7.5 step 3). */
function cooldownDevices(batches: BatchRow[], now: Date): string[] {
  return batches
    .filter((b) => b.deadlineAt <= now && now.getTime() - b.deadlineAt.getTime() < BATCH_TIMEOUT_COOLDOWN_MS)
    .map((b) => b.deviceId)
}

/**
 * Assigns the create of a pending group (§12.7.7): the requesting device when
 * it is online, else an online device of a reader in device id order.
 */
export async function assignCreate(repo: MlsRepo, deps: LightDeps, out: Outbox, group: GroupRow, preferredDevice: string | null, skip: string[]): Promise<BatchRow | null> {
  const readers = await readersOfGroup(repo, group)
  const devices = (await activeDevicesOf(repo, readers)).filter((d) => !skip.includes(d.id)).sort((a, b) => a.id.localeCompare(b.id))
  const online = await deps.presence.onlineDevices(devices.map((d) => d.id))
  const preferred = preferredDevice ? devices.find((d) => d.id === preferredDevice && online.has(d.id)) : undefined
  const assignee = preferred ?? devices.find((d) => online.has(d.id))
  if (!assignee) return null
  const batch = await repo.insertBatch({ groupId: group.groupId, epoch: 0, deviceId: assignee.id, pendingIds: [], timedOutDevices: skip, deadlineAt: deadline(deps) })
  const assign: WireBatchAssign = {
    batchId: batch.id,
    groupId: toB64(group.groupId),
    epoch: 0,
    proposals: [],
    joins: [],
    create: {
      groupId: toB64(group.groupId),
      kind: group.kind,
      guildId: group.guildId,
      channelId: group.kind === 'public_set' ? null : group.channelId,
      cipherSuite: group.cipherSuite as CipherSuiteId,
      historyVisibility: group.historyVisibility,
    },
    historyBundleEpochs: [],
    deadline: batch.deadlineAt.toISOString(),
  }
  out.toDevice(assignee.id, 'MLS_BATCH_ASSIGN', assign)
  return batch
}

/**
 * Epochs of a `shared` group whose commit added a device of a new user and
 * that have no history bundle yet (§12.11.2). Only the kept epochs count.
 */
export async function historyBundleEpochs(repo: MlsRepo, deps: Pick<DsDeps, 'ds'>, group: GroupRow): Promise<number[]> {
  if (group.historyVisibility !== 'shared') return []
  const epochs = await repo.listGroupEpochs(group.groupId)
  const candidates: number[] = []
  const usersAt = new Map<number, Set<string>>()
  for (const e of epochs) usersAt.set(e.epoch, new Set((await deps.ds.rosterOf(e.groupInfo, e.ratchetTree)).map((l) => l.userId)))
  for (const e of epochs) {
    const before = usersAt.get(e.epoch - 1)
    const now = usersAt.get(e.epoch)
    if (!before || !now) continue
    if ([...now].some((u) => !before.has(u))) candidates.push(e.epoch)
  }
  const have = await repo.historyBundleEpochs(group.groupId, candidates)
  return candidates.filter((e) => !have.has(e))
}

/** Builds and assigns one batch for an active group without a live batch. */
async function assignBatch(r: MlsRepo, deps: DsDeps, out: Outbox, group: GroupRow, skip: string[]): Promise<BatchRow | null> {
  const now = deps.now()
  const pending = await r.listPending(group.groupId, ['queued', 'assigned'])
  // Orphans of an expired batch go back to the queue.
  for (const p of pending) if (p.status === 'assigned') await r.updatePending(p.id, { status: 'queued' })

  const removes = pending.filter((p) => p.op === 'remove')
  const adds: PendingRow[] = []
  for (const p of pending.filter((x) => x.op === 'add')) {
    const device = p.deviceId ? await r.getDevice(p.deviceId) : null
    if (!device || device.status !== 'active') {
      await r.updatePending(p.id, { status: 'rejected', reason: 'revoked' })
      continue
    }
    adds.push(p)
  }
  if (removes.length === 0 && adds.length === 0) return null

  const members = await r.listMembers(group.groupId)
  const removed = new Set(removes.map((p) => p.leafIndex))
  const candidates: DeviceRow[] = []
  for (const m of members) {
    if (!m.deviceId || removed.has(m.leafIndex) || skip.includes(m.deviceId)) continue
    const d = await r.getDevice(m.deviceId)
    if (d?.status === 'active') candidates.push(d)
  }
  const online = await deps.presence.onlineDevices(candidates.map((d) => d.id))
  const committer = candidates.find((d) => online.has(d.id))

  if (!committer) {
    // §12.7.5 step 7: public_set joiners join by external commit; others wait. Removes stay queued.
    for (const p of adds) {
      const jr = p.joinRequestId ? await r.getJoinRequest(p.joinRequestId) : null
      if (!jr) continue
      const status = group.kind === 'public_set' ? 'external_commit' : 'waiting'
      if (jr.status === status) continue
      await r.updateJoinRequest(jr.id, { status, reason: 'no_member_online' }, now)
      out.toDevice(jr.deviceId, 'MLS_JOIN_UPDATE', { requestId: jr.id, groupId: toB64(group.groupId), status, reason: 'no_member_online' })
    }
    return null
  }

  const batchAdds = adds.slice(0, BATCH_MAX_ADDS)
  const proposals: string[] = []
  const joins: WireBatchAssign['joins'] = []
  const included: PendingRow[] = []
  for (const p of removes) {
    if (p.proposal && p.proposalEpoch === group.epoch) {
      proposals.push(toB64(p.proposal))
      included.push(p)
    }
  }
  for (const p of batchAdds) {
    if (group.kind === 'public_set') {
      if (p.proposal && p.proposalEpoch === group.epoch) {
        proposals.push(toB64(p.proposal))
        included.push(p)
      }
    } else if (p.keyPackage && p.userId && p.deviceId) {
      joins.push({ pendingId: p.id, userId: p.userId, deviceId: p.deviceId, keyPackage: toB64(p.keyPackage) })
      included.push(p)
    }
  }
  if (included.length === 0) return null

  const batch = await r.insertBatch({
    groupId: group.groupId,
    epoch: group.epoch!,
    deviceId: committer.id,
    pendingIds: included.map((p) => p.id),
    timedOutDevices: skip,
    deadlineAt: deadline(deps),
  })
  for (const p of included) {
    await r.updatePending(p.id, { status: 'assigned' })
    if (p.joinRequestId) {
      const jr = await r.getJoinRequest(p.joinRequestId)
      if (jr && jr.status === 'waiting') {
        await r.updateJoinRequest(jr.id, { status: 'queued', reason: null }, now)
        out.toDevice(jr.deviceId, 'MLS_JOIN_UPDATE', { requestId: jr.id, groupId: toB64(group.groupId), status: 'queued', reason: null })
      }
    }
  }
  out.toDevice(committer.id, 'MLS_BATCH_ASSIGN', {
    batchId: batch.id,
    groupId: toB64(group.groupId),
    epoch: group.epoch!,
    proposals,
    joins,
    create: null,
    historyBundleEpochs: await historyBundleEpochs(r, deps, group),
    deadline: batch.deadlineAt.toISOString(),
  })
  return batch
}

/**
 * One scheduler step for one group: sign missing proposals, then keep a live
 * batch or make the next one. Returns the live batch, or null.
 */
export async function scheduleGroup(repo: MlsRepo, deps: DsDeps, out: Outbox, groupId: Uint8Array): Promise<BatchRow | null> {
  await signPendingProposals(repo, deps, out, groupId)
  return repo.transaction(async (r) => {
    const group = await r.lockGroup(groupId)
    if (!group || group.status === 'retired') return null
    const now = deps.now()
    const batches = await r.listBatchesOfGroup(groupId)
    const live = batches.find((b) => b.deadlineAt > now)
    if (live && (group.status === 'pending' || live.epoch === group.epoch)) return live
    if (live) await r.deleteBatch(live.id) // made for an older epoch (§12.7.5 step 8)
    for (const b of batches) if (now.getTime() - b.deadlineAt.getTime() >= BATCH_TIMEOUT_COOLDOWN_MS) await r.deleteBatch(b.id)
    const skip = cooldownDevices(batches, now)
    if (group.status === 'pending') return assignCreate(r, deps, out, group, null, skip)
    return assignBatch(r, deps, out, group, skip)
  })
}

/** Every group that has work: pending creates, queued or assigned items. */
export async function runSchedulerTick(repo: MlsRepo, deps: DsDeps, out: Outbox, only?: Set<string>): Promise<void> {
  for (const g of await repo.listGroupsNeedingWork()) {
    if (only && !only.has(toB64(g.groupId))) continue
    try {
      await scheduleGroup(repo, deps, out, g.groupId)
    } catch (err) {
      console.error(`[mls-scheduler] group ${toB64(g.groupId)} failed`, err)
    }
  }
}

/** POST /mls/batches/:id/decline: the batch goes to the next device at once (§12.7.5 step 6). */
export async function declineBatch(repo: MlsRepo, deps: DsDeps, out: Outbox, deviceId: string, batchId: string): Promise<void> {
  const batch = await repo.getBatch(batchId)
  if (!batch || batch.deviceId !== deviceId) throw new ApiError('UnknownBatch', 404, 'unknown batch')
  const now = deps.now()
  if (batch.deadlineAt <= now) throw new ApiError('BatchExpired', 410, 'the batch deadline passed')
  const group = await repo.getGroup(batch.groupId)
  if (!group || (group.status === 'active' && group.epoch !== batch.epoch)) throw new ApiError('BatchExpired', 410, 'the epoch changed')
  await repo.expireBatch(batch.id, now)
  await scheduleGroup(repo, deps, out, batch.groupId)
}
