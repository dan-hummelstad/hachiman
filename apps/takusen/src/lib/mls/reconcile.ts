/**
 * Queueing of Adds and Removes (docs/gateway-protocol.md §12.7.2, §12.7.4,
 * §12.18). Takusen never commits: it puts items in `mls_pending`, and the
 * scheduler (batches.ts) gives them to a member device.
 */
import { KEY_PACKAGE_LOW_WATER } from './crypto'
import type { Outbox } from './events'
import { readersOfGroup } from './readers'
import type { DeviceRow, GroupRow, MemberRow, MlsRepo, PendingRow } from './repo'
import { toB64 } from './bytes'

const OPEN: PendingRow['status'][] = ['queued', 'assigned']

/** Queues a Remove of one leaf. A second open Remove of the leaf is skipped. */
export async function queueRemove(repo: MlsRepo, out: Outbox, group: GroupRow, member: MemberRow, reason: string): Promise<boolean> {
  const row = await repo.insertPending({
    groupId: group.groupId,
    op: 'remove',
    userId: member.userId,
    deviceId: member.deviceId,
    leafIndex: member.leafIndex,
    keyPackage: null,
    joinRequestId: null,
    reason,
  })
  if (row) out.wakeGroup(group.groupId)
  return row !== null
}

/** Emits KEY_PACKAGES_LOW when a device holds fewer than the low water mark (§12.7.2). */
export async function checkKeyPackagesLow(repo: MlsRepo, out: Outbox, deviceId: string, cipherSuite: number): Promise<void> {
  const counts = await repo.countKeyPackages(deviceId)
  const remaining = counts.find((c) => c.cipherSuite === cipherSuite)?.count ?? 0
  if (remaining < KEY_PACKAGE_LOW_WATER) out.toDevice(deviceId, 'KEY_PACKAGES_LOW', { deviceId, cipherSuite, remaining })
}

/**
 * Queues an Add by value for a device of a `channel` or `dm` group. Takusen
 * claims the key package in the group suite. Without one, it records a
 * rejected join request (`no_key_package`) and tells the device (§12.7.2).
 */
export async function queueAddByValue(repo: MlsRepo, out: Outbox, group: GroupRow, device: DeviceRow, reason: string): Promise<boolean> {
  const claim = await repo.claimKeyPackage(device.id, group.cipherSuite)
  if (!claim) {
    const jr = await repo.insertJoinRequest({
      groupId: group.groupId,
      deviceId: device.id,
      userId: device.userId,
      keyPackage: new Uint8Array(),
      status: 'rejected',
      reason: 'no_key_package',
    })
    out.toDevice(device.id, 'MLS_JOIN_UPDATE', { requestId: jr.id, groupId: toB64(group.groupId), status: 'rejected', reason: 'no_key_package' })
    return false
  }
  if (!claim.lastResort) await checkKeyPackagesLow(repo, out, device.id, group.cipherSuite)
  await repo.insertPending({
    groupId: group.groupId,
    op: 'add',
    userId: device.userId,
    deviceId: device.id,
    leafIndex: null,
    keyPackage: claim.data,
    joinRequestId: null,
    reason,
  })
  out.wakeGroup(group.groupId)
  return true
}

/** Devices that already have a leaf, an open Add, or an open join request in the group. */
async function coveredDevices(repo: MlsRepo, group: GroupRow, members: MemberRow[]): Promise<Set<string>> {
  const covered = new Set<string>()
  for (const m of members) if (m.deviceId) covered.add(m.deviceId)
  for (const p of await repo.listPending(group.groupId, OPEN)) if (p.op === 'add' && p.deviceId) covered.add(p.deviceId)
  for (const j of await repo.listOpenJoinRequests(group.groupId)) covered.add(j.deviceId)
  return covered
}

/** Queues Adds by value for every active reader device without a leaf (channel, dm). */
export async function queueAddsForReaders(repo: MlsRepo, out: Outbox, group: GroupRow, reason: string, readers?: Set<string>): Promise<void> {
  if (group.kind === 'public_set' || group.status !== 'active') return
  readers ??= await readersOfGroup(repo, group)
  const covered = await coveredDevices(repo, group, await repo.listMembers(group.groupId))
  for (const userId of readers) {
    for (const d of await repo.listDevices(userId)) {
      if (d.status === 'active' && !covered.has(d.id)) await queueAddByValue(repo, out, group, d, reason)
    }
  }
}

/** Rejects an open Add and its join request. */
export async function rejectPendingAdd(repo: MlsRepo, out: Outbox, group: GroupRow, p: PendingRow, reason: string, now: Date): Promise<void> {
  await repo.updatePending(p.id, { status: 'rejected', reason })
  if (p.joinRequestId) {
    await repo.updateJoinRequest(p.joinRequestId, { status: 'rejected', reason }, now)
    const jr = await repo.getJoinRequest(p.joinRequestId)
    if (jr) out.toDevice(jr.deviceId, 'MLS_JOIN_UPDATE', { requestId: jr.id, groupId: toB64(group.groupId), status: 'rejected', reason })
  }
}

/**
 * Recomputes the readers of an active group (§12.18 `onMembershipChange`):
 * Removes for leaves of non-readers, revoked or deleted devices, deleted users;
 * Adds for new reader devices of `channel` and `dm` groups; rejection of open
 * Adds that lost their reader.
 */
export async function reconcileGroup(repo: MlsRepo, out: Outbox, group: GroupRow, reason: string, now: Date): Promise<void> {
  if (group.status !== 'active') return
  const readers = await readersOfGroup(repo, group)
  for (const m of await repo.listMembers(group.groupId)) {
    const device = m.deviceId ? await repo.getDevice(m.deviceId) : null
    const gone = !m.userId || !device || device.status === 'revoked' || !readers.has(m.userId)
    if (gone) await queueRemove(repo, out, group, m, reason)
  }
  for (const p of await repo.listPending(group.groupId, OPEN)) {
    if (p.op !== 'add') continue
    const device = p.deviceId ? await repo.getDevice(p.deviceId) : null
    if (!p.userId || !readers.has(p.userId) || !device || device.status === 'revoked') {
      await rejectPendingAdd(repo, out, group, p, 'not_reader', now)
    }
  }
  await queueAddsForReaders(repo, out, group, reason, readers)
}
