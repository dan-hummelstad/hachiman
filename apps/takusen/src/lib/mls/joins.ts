/**
 * Join requests (docs/gateway-protocol.md §12.7.8).
 */
import { ApiError } from '@/lib/errors'

import { toB64 } from './bytes'
import type { DsDeps } from './context'
import type { Outbox } from './events'
import { requireReadableGroup } from './groups'
import { currentDsk } from './identity'
import { inspectOwnKeyPackage } from './key-packages'
import { checkKeyPackagesLow } from './reconcile'
import type { DeviceRow, JoinRequestRow, MlsRepo } from './repo'
import { toWireJoinRequest } from './shapes'

type Deps = Pick<DsDeps, 'ds' | 'config' | 'now'>

export async function postJoinRequest(
  repo: MlsRepo,
  deps: Deps,
  out: Outbox,
  caller: { userId: string; device: DeviceRow },
  groupId: Uint8Array,
  keyPackage: Uint8Array,
) {
  return repo.transaction(async (r) => {
    const { group } = await requireReadableGroup(r, groupId, caller.userId)
    if (group.status === 'retired') throw new ApiError('GroupRetired', 410, 'the group is retired')
    if (group.status === 'pending') throw new ApiError('GroupPending', 409, 'the group is not active yet')
    const now = deps.now()
    const members = await r.listMembers(group.groupId)
    if (group.kind === 'public_set' && members.length >= deps.config.publicSetMaxMembers) {
      throw new ApiError('GroupFull', 403, `the group has ${deps.config.publicSetMaxMembers} leaves`)
    }
    const emit = (jr: JoinRequestRow) =>
      out.toDevice(jr.deviceId, 'MLS_JOIN_UPDATE', { requestId: jr.id, groupId: toB64(group.groupId), status: jr.status, reason: jr.reason })

    // The key package must be in the group suite. Else Takusen claims a stored one (§12.7.2).
    let kp: Uint8Array | null = keyPackage
    let suite: number
    try {
      suite = (await deps.ds.inspectKeyPackage(keyPackage)).cipherSuite
    } catch {
      throw new ApiError('InvalidKeyPackage', 400, 'the key package does not decode')
    }
    if (suite !== group.cipherSuite) {
      const claim = await r.claimKeyPackage(caller.device.id, group.cipherSuite)
      if (claim && !claim.lastResort) await checkKeyPackagesLow(r, out, caller.device.id, group.cipherSuite)
      kp = claim?.data ?? null
    } else {
      const dsk = currentDsk(await r.listDsks(caller.userId))
      if (!dsk) throw new ApiError('InvalidKeyPackage', 400, 'the user has no device-signing key')
      await inspectOwnKeyPackage(deps, caller.device, keyPackage, group.cipherSuite, dsk.generation)
    }

    // A new request replaces the open requests of the device in this group.
    for (const old of await r.listOpenJoinRequests(group.groupId)) {
      if (old.deviceId !== caller.device.id) continue
      await r.updateJoinRequest(old.id, { status: 'rejected', reason: 'superseded' }, now)
      const stale = (await r.listPending(group.groupId, ['queued', 'assigned'])).filter((p) => p.joinRequestId === old.id)
      await r.deletePending(stale.map((p) => p.id))
    }

    if (!kp) {
      const jr = await r.insertJoinRequest({ groupId: group.groupId, deviceId: caller.device.id, userId: caller.userId, keyPackage, status: 'rejected', reason: 'no_key_package' })
      emit(jr)
      return toWireJoinRequest(jr)
    }
    const ownLeaf = members.some((m) => m.deviceId === caller.device.id)
    const userLeaf = members.some((m) => m.userId === caller.userId)
    // channel and dm: a user who has a leaf adds the new device by external commit at once.
    if (ownLeaf || (group.kind !== 'public_set' && userLeaf)) {
      const jr = await r.insertJoinRequest({ groupId: group.groupId, deviceId: caller.device.id, userId: caller.userId, keyPackage: kp, status: 'external_commit', reason: ownLeaf ? 'resync' : 'own_device' })
      emit(jr)
      return toWireJoinRequest(jr)
    }
    const jr = await r.insertJoinRequest({ groupId: group.groupId, deviceId: caller.device.id, userId: caller.userId, keyPackage: kp, status: 'queued', reason: null })
    await r.insertPending({
      groupId: group.groupId,
      op: 'add',
      userId: caller.userId,
      deviceId: caller.device.id,
      leafIndex: null,
      keyPackage: kp,
      joinRequestId: jr.id,
      reason: 'join_request',
    })
    out.wakeGroup(group.groupId)
    emit(jr)
    return toWireJoinRequest(jr)
  })
}

export async function getJoinRequest(repo: MlsRepo, caller: { userId: string }, id: string) {
  const jr = await repo.getJoinRequest(id)
  if (!jr || jr.userId !== caller.userId) throw new ApiError('NotFound', 404, 'unknown join request')
  return toWireJoinRequest(jr)
}
