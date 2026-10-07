/**
 * Commit upload: POST /mls/groups/:groupId/commits (docs/gateway-protocol.md
 * §12.7.3). `DsModule.checkCommit` does the checks that need no database
 * (2-7). This file adds the database checks (1, the device rows of 7, 8), the
 * policy (9), the compare-and-set (10) and the writes (11).
 *
 * The DS never makes a commit. It only orders and checks them.
 */
import { has, Permissions } from '@hachiman/client/permissions'

import { ApiError } from '@/lib/errors'

import { proposalRejections, settleRejections, type CommitterRejection, type RejectedProposal } from './batches'
import { bytesEqual, toB64 } from './bytes'
import { INBOX_ITEM_MAX_BYTES, INBOX_RETENTION_MS } from './config'
import type { DsDeps } from './context'
import { GROUP_STATE_EPOCHS_KEPT, INVITE_AUTH_WINDOW_MS, type CommitInspection, type LeafEntry } from './crypto'
import { emitToGroup, handshakeEvent, type Outbox } from './events'
import { signProposalsLocked } from './proposals'
import { channelPermissionsOf, hasGuildPermission, readersOfGroup } from './readers'
import type { DeviceRow, GroupRow, MemberRow, MlsRepo, NewMember, PendingRow } from './repo'
import { toWireGroup } from './shapes'
import { encodeWelcomeItem, parseGroupInfoContext, parsePublicMessagePrefix, type GroupContextSummary } from './wire-format'

export interface CommitBody {
  epoch: number
  commit: Uint8Array
  groupInfo: Uint8Array
  ratchetTree: Uint8Array
  welcome: Uint8Array | null
  batchId: string | null
  rejected: { pendingId: string; reason: string }[]
  /** DS proposals of the batch that the committer refused, by ProposalRef (`rejectBatchProposals`). */
  rejectedProposals?: RejectedProposal[]
}

type Deps = Pick<DsDeps, 'ds' | 'signer' | 'config' | 'strikes' | 'now'>

/** Maps a `DsModule.checkCommit` failure to its §12.19 code. */
export function commitCheckError(reason: string): ApiError {
  if (/chain/i.test(reason)) return new ApiError('IllegalAdd', 403, reason)
  return new ApiError('InvalidCommit', 400, reason)
}

const epochConflict = (epoch: number | null) => new ApiError('EpochConflict', 409, 'another commit won the epoch', { epoch })

export async function uploadCommit(
  repo: MlsRepo,
  deps: Deps,
  out: Outbox,
  caller: { userId: string; device: DeviceRow },
  groupId: Uint8Array,
  body: CommitBody,
): Promise<{ epoch: number; seq: number }> {
  return repo.transaction(async (r) => {
    // 1. The group, and the caller reads it. (requireDevice made sure the device is active.)
    const group = await r.lockGroup(groupId)
    if (!group) throw new ApiError('UnknownGroup', 404, 'unknown group')
    if (group.status === 'retired') throw new ApiError('GroupRetired', 410, 'the group is retired')
    if (group.status === 'pending' || group.epoch === null || !group.groupInfo || !group.ratchetTree) {
      throw new ApiError('GroupPending', 409, 'the group is not active yet')
    }
    const readers = await readersOfGroup(r, group)
    if (!readers.has(caller.userId)) throw new ApiError('UnknownGroup', 404, 'unknown group')
    const epoch = group.epoch

    // 2. Framing, group id and epoch, before the expensive checks.
    let prefix
    let nextCtx: GroupContextSummary
    try {
      prefix = parsePublicMessagePrefix(body.commit)
      nextCtx = parseGroupInfoContext(body.groupInfo)
    } catch {
      throw new ApiError('InvalidCommit', 400, 'the commit or GroupInfo does not decode')
    }
    if (prefix.contentType !== 'commit') throw new ApiError('InvalidCommit', 400, 'not a commit')
    if (!bytesEqual(prefix.groupId, groupId)) throw new ApiError('InvalidCommit', 400, 'the commit is for another group')
    if (prefix.epoch !== epoch || body.epoch !== epoch) throw epochConflict(epoch)
    if (!bytesEqual(nextCtx.groupId, groupId) || nextCtx.epoch !== epoch + 1) {
      throw new ApiError('InvalidCommit', 400, 'GroupInfo must be of the group at epoch + 1')
    }

    // 3-7 without the database.
    const pending = await r.listPending(groupId, ['queued', 'assigned'])
    // The signed proposals themselves, not their refs: ds.ts then applies each
    // referenced proposal, so the roster transition is exact and a commit cannot
    // hide an Add (Implementation note 3).
    const published = pending.filter((p) => p.proposal && p.proposalEpoch === epoch).map((p) => p.proposal!)
    const previousMembers = await r.listMembers(groupId)
    let uploadedRoster: LeafEntry[]
    try {
      uploadedRoster = await deps.ds.rosterOf(body.groupInfo, body.ratchetTree)
    } catch {
      throw new ApiError('InvalidCommit', 400, 'the ratchet tree does not decode')
    }
    const masterKeys = await currentMasterKeys(r, [...uploadedRoster.map((l) => l.userId), ...previousMembers.flatMap((m) => (m.userId ? [m.userId] : []))])
    const check = await deps.ds.checkCommit({
      groupId,
      epoch,
      commit: body.commit,
      groupInfo: body.groupInfo,
      ratchetTree: body.ratchetTree,
      previous: { groupInfo: group.groupInfo, ratchetTree: group.ratchetTree },
      sender: { userId: caller.userId, deviceId: caller.device.id },
      publishedProposals: published,
      masterKeys: (userId) => masterKeys.get(userId) ?? null,
    })
    if (!check.ok) throw commitCheckError(check.reason)
    const insp = check.inspection
    if (!bytesEqual(insp.groupId, groupId) || insp.epoch !== epoch || insp.next.epoch !== epoch + 1 || !insp.next.hasExternalPub) {
      throw new ApiError('InvalidCommit', 400, 'the inspection does not match the upload')
    }
    for (const t of insp.proposalTypes) {
      if (t === 'psk' || t === 'reinit' || t === 'update' || t === 'other') throw new ApiError('InvalidCommit', 400, `proposal type ${t} is not allowed`)
      if (t === 'external_init' && insp.sender.type !== 'new_member_commit') throw new ApiError('InvalidCommit', 400, 'external_init outside an external commit')
    }

    const prevByLeaf = new Map(previousMembers.map((m) => [m.leafIndex, m]))
    const changed = new Set(insp.changedLeaves)
    const removed = new Set(insp.removedLeaves)
    const openRemoves = new Map(pending.filter((p) => p.op === 'remove' && p.leafIndex !== null).map((p) => [p.leafIndex!, p]))

    // 7. New and changed leaves: a registered, certified device of the user, not revoked.
    const nextDevices = new Map<number, DeviceRow>()
    for (const leaf of insp.next.roster) {
      if (!changed.has(leaf.leafIndex)) continue
      const device = await r.getDevice(leaf.deviceId)
      if (!device || device.userId !== leaf.userId || device.status !== 'active' || !device.mlsSignatureKey || !bytesEqual(device.mlsSignatureKey, leaf.signatureKey)) {
        throw new ApiError('IllegalAdd', 403, `leaf ${leaf.leafIndex}: the device is not registered, certified and active`)
      }
      nextDevices.set(leaf.leafIndex, device)
    }

    // 8 + 9. Unchanged leaves of revoked or deleted devices, deleted users or
    // non-readers stay only while a Remove of their leaf is queued.
    const illegal = new Set<string>()
    for (const leaf of insp.next.roster) {
      if (changed.has(leaf.leafIndex)) {
        if (!readers.has(leaf.userId)) illegal.add(leaf.userId)
        continue
      }
      const prev = prevByLeaf.get(leaf.leafIndex)
      const device = prev?.deviceId ? await r.getDevice(prev.deviceId) : null
      const ok = prev && prev.userId && device && device.status !== 'revoked' && readers.has(prev.userId)
      if (!ok && !openRemoves.has(leaf.leafIndex)) illegal.add(prev?.userId ?? leaf.userId)
    }
    if (illegal.size > 0) throw new ApiError('IllegalMembership', 403, 'the next roster has users who must not be members', { userIds: [...illegal] })

    // 9. Policy (§12.7.3 table).
    await checkPolicy(r, deps, group, readers, insp, caller, prevByLeaf, pending)
    if (group.kind === 'public_set' && insp.next.roster.length > deps.config.publicSetMaxMembers && insp.next.roster.length > previousMembers.length) {
      throw new ApiError('GroupFull', 403, `the group has at most ${deps.config.publicSetMaxMembers} leaves`)
    }
    const newDevices = insp.next.roster.filter((l) => changed.has(l.leafIndex) && l.deviceId !== caller.device.id && !previousMembers.some((m) => m.deviceId === l.deviceId))
    if (newDevices.length > 0 && !body.welcome) throw new ApiError('InvalidCommit', 400, 'a commit that adds devices needs a Welcome')
    if (body.welcome && body.welcome.length > INBOX_ITEM_MAX_BYTES) throw new ApiError('InboxFull', 413, 'the Welcome is above 1 MiB')

    // 10. Compare-and-set.
    const now = deps.now()
    const removedOther = [...removed].some((leaf) => prevByLeaf.get(leaf)?.deviceId !== caller.device.id)
    const descriptor = insp.descriptorChanged ? insp.next.descriptor : null
    const won = await r.casGroupEpoch(groupId, epoch, {
      epoch: epoch + 1,
      groupInfo: body.groupInfo,
      ratchetTree: body.ratchetTree,
      epochStartedAt: now,
      lastCommitRemoved: removedOther,
      ...(descriptor ? { historyVisibility: descriptor.historyVisibility } : {}),
    })
    if (!won) throw epochConflict((await r.getGroup(groupId))?.epoch ?? null)

    // 11. Handshake, state, roster, Welcomes, applied items.
    const handshake = {
      groupId,
      epoch,
      kind: insp.sender.type === 'new_member_commit' ? ('external_commit' as const) : ('commit' as const),
      senderDevice: caller.device.id,
      message: body.commit,
      treeHash: nextCtx.treeHash,
      confirmedTranscriptHash: nextCtx.confirmedTranscriptHash,
    }
    const seq = await r.appendHandshake(handshake)
    await r.insertGroupEpoch({ groupId, epoch: epoch + 1, groupInfo: body.groupInfo, ratchetTree: body.ratchetTree, treeHash: nextCtx.treeHash, confirmedTranscriptHash: nextCtx.confirmedTranscriptHash })
    await r.pruneGroupEpochs(groupId, epoch + 2 - GROUP_STATE_EPOCHS_KEPT)
    await r.replaceMembers(groupId, nextRoster(insp, prevByLeaf, nextDevices))

    const nextGroup: GroupRow = { ...group, epoch: epoch + 1, groupInfo: body.groupInfo, ratchetTree: body.ratchetTree, epochStartedAt: now, lastCommitRemoved: removedOther, latestSeq: seq, historyVisibility: descriptor?.historyVisibility ?? group.historyVisibility }
    await emitToGroup(r, out, nextGroup, 'MLS_HANDSHAKE', handshakeEvent({ ...handshake, seq }))

    if (body.welcome) {
      const item = encodeWelcomeItem(groupId, epoch + 1, body.welcome)
      for (const leaf of newDevices) {
        const row = await r.insertInboxItem({ deviceId: leaf.deviceId, kind: 'welcome', senderDevice: caller.device.id, body: item, size: item.length, expiresAt: new Date(now.getTime() + INBOX_RETENTION_MS) })
        out.toDevice(leaf.deviceId, 'DEVICE_INBOX', { id: row.id, seq: row.seq, kind: 'welcome' })
      }
    }
    const falseRejections = await settlePending(r, deps, out, nextGroup, caller, body, pending, removed, new Set(insp.next.roster.filter((l) => changed.has(l.leafIndex)).map((l) => l.deviceId)), now)
    await r.deleteBatchesOfGroup(groupId)
    // §12.7.5: after a false rejection, the next batch goes to the next committer.
    // An expired batch row of the caller is the cooldown marker of step 3.
    if (falseRejections > 0) {
      await r.insertBatch({ groupId, epoch: epoch + 1, deviceId: caller.device.id, pendingIds: [], timedOutDevices: [], deadlineAt: now })
    }
    if (descriptor) await emitToGroup(r, out, nextGroup, 'MLS_GROUP_UPDATE', toWireGroup(nextGroup, false))

    // §12.7.4: the items that are still pending get one proposal for the new epoch.
    await signProposalsLocked(r, deps, out, nextGroup)
    if ((await r.listPending(groupId, ['queued'])).length > 0) out.wakeGroup(groupId)
    return { epoch: epoch + 1, seq }
  })
}

/** The current master public key of each user, for the chain checks of checkCommit. */
async function currentMasterKeys(r: MlsRepo, userIds: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>()
  for (const u of new Set(userIds)) {
    const m = (await r.listMasterKeys(u)).find((x) => x.supersededAt === null)
    if (m) out.set(u, m.publicKey)
  }
  return out
}

function nextRoster(insp: CommitInspection, prevByLeaf: Map<number, MemberRow>, nextDevices: Map<number, DeviceRow>): NewMember[] {
  const changed = new Set(insp.changedLeaves)
  return insp.next.roster.map((leaf) => {
    const prev = prevByLeaf.get(leaf.leafIndex)
    if (!changed.has(leaf.leafIndex) && prev) {
      return { leafIndex: prev.leafIndex, deviceId: prev.deviceId, userId: prev.userId, credentialIdentity: prev.credentialIdentity, signatureKey: prev.signatureKey }
    }
    const device = nextDevices.get(leaf.leafIndex)!
    return { leafIndex: leaf.leafIndex, deviceId: device.id, userId: device.userId, credentialIdentity: `${leaf.userId}:${leaf.deviceId}`, signatureKey: leaf.signatureKey }
  })
}

/**
 * §12.7.3 policy for one commit. Adds and the membership itself are checked
 * by checks 7-9. This checks the external commit rule, the Removes by value
 * and the GroupContextExtensions rule.
 */
async function checkPolicy(
  r: MlsRepo,
  deps: Pick<Deps, 'ds' | 'now'>,
  group: GroupRow,
  readers: Set<string>,
  insp: CommitInspection,
  caller: { userId: string; device: DeviceRow },
  prevByLeaf: Map<number, MemberRow>,
  pending: PendingRow[],
): Promise<void> {
  const callerLeaves = [...prevByLeaf.values()].filter((m) => m.userId === caller.userId)
  if (insp.sender.type === 'new_member_commit') {
    // External commit: public_set takes any reader device. channel and dm need a user that has a
    // leaf, or (channel) a valid InviteAuth of a redeemer (§12.11.4).
    if (group.kind !== 'public_set' && callerLeaves.length === 0) {
      const why = group.kind === 'channel' ? await inviteJoinRefusal(r, deps, group, insp, caller) : 'not a channel group'
      if (why !== null) throw new ApiError('IllegalAdd', 403, `an external commit here needs a user who already has a leaf, or a valid invite authorization: ${why}`)
    }
  } else {
    const leaf = prevByLeaf.get(insp.sender.leafIndex)
    if (!leaf || leaf.deviceId !== caller.device.id) throw new ApiError('InvalidCommit', 400, 'the sender leaf is not the request device')
  }

  // Removes by value: own devices, non-readers, revoked or deleted devices.
  const refs = insp.proposalRefs
  const byRef = new Set(pending.filter((p) => p.op === 'remove' && p.proposalRef && refs.some((ref) => bytesEqual(ref, p.proposalRef))).map((p) => p.leafIndex))
  for (const leafIndex of insp.removedLeaves) {
    if (byRef.has(leafIndex)) continue
    const prev = prevByLeaf.get(leafIndex)
    if (!prev || !prev.userId || !prev.deviceId) continue
    if (prev.userId === caller.userId || !readers.has(prev.userId)) continue
    const device = await r.getDevice(prev.deviceId)
    if (!device || device.status === 'revoked') continue
    throw new ApiError('IllegalRemove', 403, `leaf ${leafIndex}: the committer may not remove this member`)
  }

  if (insp.descriptorChanged) {
    const d = insp.next.descriptor
    if (group.kind === 'dm') throw new ApiError('InvalidCommit', 400, 'a dm group cannot change its descriptor')
    if (!d || d.kind !== group.kind || d.guildId !== group.guildId || d.channelId !== (group.kind === 'public_set' ? null : group.channelId)) {
      throw new ApiError('InvalidCommit', 400, 'only history_visibility may change in the descriptor')
    }
    const allowed = group.kind === 'public_set' ? await guildHas(r, group.guildId!, caller.userId, Permissions.MANAGE_GUILD) : has(await channelPermissionsOf(r, group.channelId!, caller.userId), Permissions.MANAGE_CHANNELS)
    if (!allowed) throw new ApiError('MissingPermissions', 403, 'the committer may not change history_visibility')
  }
}

/**
 * §12.11.4 "Join authorization": the external commit of a user without a
 * leaf into a `channel` group carries an InviteAuth in `authenticated_data`.
 * Takusen checks its signature over the group and the new leaf key, compares
 * its record with the stored record of the invite (verified at POST), and
 * checks the invite, the scope and the join window. The members check the
 * admin state of the record (§12.16). Null when the join is allowed, else the
 * reason.
 */
async function inviteJoinRefusal(
  r: MlsRepo,
  deps: Pick<Deps, 'ds' | 'now'>,
  group: GroupRow,
  insp: CommitInspection,
  caller: { userId: string; device: DeviceRow },
): Promise<string | null> {
  if (insp.authenticatedData.length === 0) return 'no invite authorization'
  const leaf = insp.next.roster.find((l) => l.deviceId === caller.device.id && l.userId === caller.userId)
  if (!leaf || group.channelId === null) return 'no new leaf'
  const auth = deps.ds.verifyInviteAuth({ authenticatedData: insp.authenticatedData, groupId: group.groupId, leafSignatureKey: leaf.signatureKey })
  if (!auth) return 'the invite authorization does not verify'
  const invite = await r.getInviteByKeyId(auth.keyId)
  if (!invite || invite.guildId !== group.guildId || invite.record === null || !bytesEqual(invite.record, auth.signedRecord)) return 'unknown invite'
  const now = deps.now()
  if (invite.revoked || (invite.expiresAt !== null && invite.expiresAt <= now)) return 'the invite is revoked or expired'
  if (!auth.record.channelIds.includes(group.channelId)) return 'the channel is not in the scope of the invite'
  const joinedAt = await r.inviteJoinedBy(invite.id, caller.userId)
  if (!joinedAt || now.getTime() - joinedAt.getTime() > INVITE_AUTH_WINDOW_MS) return 'the user did not join the guild with this invite in the last 24 h'
  return null
}

async function guildHas(r: MlsRepo, guildId: string, userId: string, bit: number): Promise<boolean> {
  const data = await r.getGuildPermissionData(guildId)
  return data !== null && hasGuildPermission(data, userId, bit)
}

/**
 * Deletes the items that the commit applied (§12.7.5 step 8), settles the
 * items that the committer rejected in its batch (`settleRejections`), and
 * updates the join requests. Returns the number of false rejections.
 */
async function settlePending(
  r: MlsRepo,
  deps: Pick<DsDeps, 'strikes'>,
  out: Outbox,
  group: GroupRow,
  caller: { device: DeviceRow },
  body: CommitBody,
  pending: PendingRow[],
  removedLeaves: Set<number>,
  addedDevices: Set<string>,
  now: Date,
): Promise<number> {
  const applied: string[] = []
  for (const p of pending) {
    if (p.op === 'remove' && p.leafIndex !== null && removedLeaves.has(p.leafIndex)) applied.push(p.id)
    if (p.op === 'add' && p.deviceId && addedDevices.has(p.deviceId)) applied.push(p.id)
  }
  await r.deletePending(applied)
  for (const jr of await r.listOpenJoinRequests(group.groupId)) {
    if (!addedDevices.has(jr.deviceId)) continue
    await r.updateJoinRequest(jr.id, { status: 'committed', reason: null }, now)
    out.toDevice(jr.deviceId, 'MLS_JOIN_UPDATE', { requestId: jr.id, groupId: toB64(group.groupId), status: 'committed', reason: null })
  }

  const rejectedProposals = body.rejectedProposals ?? []
  if (!body.batchId || (body.rejected.length === 0 && rejectedProposals.length === 0)) return 0
  const batch = await r.getBatch(body.batchId)
  // Only the assigned committer of the batch reports rejections.
  if (!batch || batch.deviceId !== caller.device.id || !bytesEqual(batch.groupId, group.groupId)) return 0
  const inBatch = new Set(batch.pendingIds)
  const appliedSet = new Set(applied)
  const items: CommitterRejection[] = await proposalRejections(r, batch, rejectedProposals, appliedSet)
  const rows = await r.getPendingByIds(body.rejected.map((x) => x.pendingId).filter((id) => inBatch.has(id) && !appliedSet.has(id)))
  for (const p of rows) items.push({ pending: p, reason: body.rejected.find((x) => x.pendingId === p.id)!.reason })
  return settleRejections(r, deps, out, group, caller.device.id, items, now)
}
