/**
 * Group allocation, creation and reads (docs/gateway-protocol.md §12.6, §12.7.7, §12.15).
 */
import { ApiError } from '@/lib/errors'

import { bytesEqual, fromB64, toB64, uuidToBytes } from './bytes'
import { CipherSuite, ExtensionType, GroupKind, type CipherSuiteId } from './crypto'
import type { DsDeps, LightDeps } from './context'
import { emitToGroup, type Outbox } from './events'
import { readersOfGroup } from './readers'
import type { DeviceRow, GroupKind as GroupKindName, GroupRow, MlsRepo } from './repo'
import { toWireGroup } from './shapes'
import { parseGroupInfoContext } from './wire-format'
import { queueAddsForReaders } from './reconcile'
import { assignCreate } from './batches'

const KIND_BYTE: Record<GroupKindName, number> = { public_set: GroupKind.PUBLIC_SET, channel: GroupKind.CHANNEL, dm: GroupKind.DM }

/** struct { uint8 version = 1; uint8 kind; opaque scope[16]; uint32 generation; } GroupId (22 bytes, §12.6). */
export function encodeGroupId(kind: GroupKindName, scopeId: string, generation: number): Uint8Array {
  const out = new Uint8Array(22)
  out[0] = 1
  out[1] = KIND_BYTE[kind]
  out.set(uuidToBytes(scopeId), 2)
  new DataView(out.buffer).setUint32(18, generation)
  return out
}

/** The group id of a route parameter. 404 UnknownGroup when it does not decode. */
export function parseGroupIdParam(param: string): Uint8Array {
  const id = fromB64(param)
  if (!id || id.length !== 22) throw new ApiError('UnknownGroup', 404, 'unknown group')
  return id
}

/**
 * §12.15: suite 83 when the DS enables it and every reader device has a
 * suite-83 key package, else the default suite.
 */
export async function chooseSuite(repo: MlsRepo, deps: Pick<LightDeps, 'config'>, readerDeviceIds: string[]): Promise<CipherSuiteId> {
  const base = deps.config.suites.includes(CipherSuite.X25519_AES128GCM_SHA256_ED25519)
    ? CipherSuite.X25519_AES128GCM_SHA256_ED25519
    : deps.config.suites[0]!
  const pq = CipherSuite.XWING_AES256GCM_SHA512_ED25519
  if (!deps.config.suites.includes(pq) || readerDeviceIds.length === 0) return base
  const have = await repo.devicesWithKeyPackage(readerDeviceIds, pq)
  return readerDeviceIds.every((id) => have.has(id)) ? pq : base
}

/** Active devices of a set of users. */
export async function activeDevicesOf(repo: MlsRepo, userIds: Iterable<string>): Promise<DeviceRow[]> {
  const out: DeviceRow[] = []
  for (const u of userIds) for (const d of await repo.listDevices(u)) if (d.status === 'active') out.push(d)
  return out
}

/**
 * Allocates a new group (status pending, next generation) and assigns the
 * create (§12.7.7). The assignee is `preferredDevice` when it is online.
 */
export async function allocateGroup(
  repo: MlsRepo,
  deps: LightDeps,
  out: Outbox,
  input: { kind: GroupKindName; scopeId: string; guildId: string | null; channelId: string | null; historyVisibility: GroupRow['historyVisibility'] },
  preferredDevice: string | null,
): Promise<GroupRow> {
  const generation = await repo.nextGroupGeneration(input.kind, input.scopeId)
  const readers = await readersOfGroup(repo, input)
  const devices = await activeDevicesOf(repo, readers)
  const cipherSuite = await chooseSuite(repo, deps, devices.map((d) => d.id))
  const group = await repo.insertGroup({
    groupId: encodeGroupId(input.kind, input.scopeId, generation),
    kind: input.kind,
    scopeId: input.scopeId,
    guildId: input.guildId,
    channelId: input.kind === 'public_set' ? null : input.channelId,
    generation,
    cipherSuite,
    status: 'pending',
    epoch: null,
    groupInfo: null,
    ratchetTree: null,
    historyVisibility: input.historyVisibility,
  })
  await assignCreate(repo, deps, out, group, preferredDevice, [])
  return group
}

/** Marks a group retired and drops its queued work. Members keep it for history (§12.6). */
export async function retireGroup(repo: MlsRepo, out: Outbox, group: GroupRow): Promise<void> {
  if (group.status === 'retired') return
  await repo.updateGroup(group.groupId, { status: 'retired' })
  await repo.deleteGroupWork(group.groupId)
  await emitToGroup(repo, out, group, 'MLS_GROUP_UPDATE', toWireGroup({ ...group, status: 'retired' }, false))
}

/** A group the user reads, else 404 UnknownGroup (§12.19). */
export async function requireReadableGroup(repo: MlsRepo, groupId: Uint8Array, userId: string): Promise<{ group: GroupRow; readers: Set<string> }> {
  const group = await repo.getGroup(groupId)
  if (!group) throw new ApiError('UnknownGroup', 404, 'unknown group')
  const readers = await readersOfGroup(repo, group)
  if (!readers.has(userId)) throw new ApiError('UnknownGroup', 404, 'unknown group')
  return { group, readers }
}

export async function wireGroupFor(repo: MlsRepo, group: GroupRow, deviceId: string) {
  return toWireGroup(group, (await repo.memberByDevice(group.groupId, deviceId)) !== null)
}

// MARK: - Reads

/** GET /mls/groups: every group the user reads, with `member` for the caller's device. */
export async function listGroupsForUser(repo: MlsRepo, userId: string, deviceId: string) {
  const seen = new Set<string>()
  const groups: GroupRow[] = []
  const add = (g: GroupRow) => {
    const k = toB64(g.groupId)
    if (!seen.has(k)) {
      seen.add(k)
      groups.push(g)
    }
  }
  for (const guildId of await repo.guildIdsOfUser(userId)) {
    for (const g of await repo.listGroupsByGuild(guildId)) {
      if (g.kind === 'public_set' || (await readersOfGroup(repo, g)).has(userId)) add(g)
    }
  }
  for (const channelId of await repo.dmChannelIdsOfUser(userId)) for (const g of await repo.listGroupsByChannel(channelId)) add(g)
  const mine = new Set((await repo.groupIdsOfDevice(deviceId)).map(toB64))
  return groups.map((g) => toWireGroup(g, mine.has(toB64(g.groupId))))
}

/** GET /channels/:id/mls-group. */
export async function channelGroup(repo: MlsRepo, channelId: string, userId: string, deviceId: string) {
  const channel = await repo.getChannel(channelId)
  if (!channel?.mlsGroupId) throw new ApiError('UnknownGroup', 404, 'the channel has no group')
  const { group } = await requireReadableGroup(repo, channel.mlsGroupId, userId)
  return wireGroupFor(repo, group, deviceId)
}

/** GET /mls/groups/:groupId/state?epoch= (§12.7.6). */
export async function groupState(repo: MlsRepo, groupId: Uint8Array, userId: string, epochParam: string | null) {
  const { group } = await requireReadableGroup(repo, groupId, userId)
  if (group.status === 'pending' || group.epoch === null || !group.groupInfo || !group.ratchetTree) {
    throw new ApiError('GroupPending', 409, 'the group is not active yet')
  }
  if (epochParam === null || Number(epochParam) === group.epoch) {
    return { groupId: toB64(groupId), epoch: group.epoch, groupInfo: toB64(group.groupInfo), ratchetTree: toB64(group.ratchetTree) }
  }
  const epoch = Number(epochParam)
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new ApiError('ValidationError', 400, 'bad epoch')
  const row = await repo.getGroupEpoch(groupId, epoch)
  if (!row) throw new ApiError('EpochNotKept', 410, 'the state of that epoch is gone')
  return { groupId: toB64(groupId), epoch, groupInfo: toB64(row.groupInfo), ratchetTree: toB64(row.ratchetTree) }
}

// MARK: - POST /mls/groups (§12.7.7)

/** RequiredCapabilities of §12.6: extensions 0xF1A0 and 0xF1A1, no proposal types, credential basic. */
export const REQUIRED_CAPABILITIES = new Uint8Array([0x04, 0xf1, 0xa0, 0xf1, 0xa1, 0x00, 0x02, 0x00, 0x01])
/** RFC 9420 extension type ids. */
export const EXT_EXTERNAL_SENDERS = 0x0005
export const EXT_REQUIRED_CAPABILITIES = 0x0003
export const GROUP_CONTEXT_EXTENSIONS = [EXT_EXTERNAL_SENDERS, EXT_REQUIRED_CAPABILITIES, ExtensionType.GROUP_DESCRIPTOR]

export interface CreateGroupInput {
  groupId: Uint8Array
  kind: GroupKindName
  guildId: string | null
  channelId: string | null
  cipherSuite: number
  groupInfo: Uint8Array
  ratchetTree: Uint8Array
  assignmentId: string | null
}

export async function createGroup(
  repo: MlsRepo,
  deps: Pick<DsDeps, 'ds' | 'signer' | 'now'>,
  out: Outbox,
  caller: { userId: string; device: DeviceRow },
  input: CreateGroupInput,
) {
  return repo.transaction(async (r) => {
    const group = await r.lockGroup(input.groupId)
    if (!group) throw new ApiError('IllegalAdd', 403, 'no such group to create')
    if (group.status === 'active' || group.status === 'retired') throw new ApiError('GroupExists', 409, 'the group exists')
    const now = deps.now()
    const batch = input.assignmentId ? await r.getBatch(input.assignmentId) : null
    if (!batch || !bytesEqual(batch.groupId, group.groupId) || batch.deviceId !== caller.device.id) {
      throw new ApiError('IllegalAdd', 403, 'the caller is not the assignee')
    }
    const expectedId = encodeGroupId(group.kind, group.scopeId, group.generation)
    if (
      !bytesEqual(expectedId, input.groupId) ||
      input.kind !== group.kind ||
      input.cipherSuite !== group.cipherSuite ||
      (input.guildId ?? null) !== group.guildId ||
      (group.kind !== 'public_set' && (input.channelId ?? null) !== group.channelId)
    ) {
      throw new ApiError('InvalidCommit', 400, 'the request does not match the allocated group')
    }

    const insp = await deps.ds.inspectGroupInfo(input.groupInfo, input.ratchetTree)
    if (!bytesEqual(insp.groupId, input.groupId) || insp.cipherSuite !== group.cipherSuite) {
      throw new ApiError('InvalidCommit', 400, 'GroupInfo has another group id or suite')
    }
    if (insp.epoch !== 0 || !insp.signatureValid || !insp.treeHashValid) {
      throw new ApiError('InvalidCommit', 400, 'GroupInfo needs epoch 0, a valid signature and a matching tree hash')
    }
    const leaf = insp.roster.length === 1 ? insp.roster[0]! : null
    if (
      !leaf ||
      leaf.userId !== caller.userId ||
      leaf.deviceId !== caller.device.id ||
      !caller.device.mlsSignatureKey ||
      !bytesEqual(leaf.signatureKey, caller.device.mlsSignatureKey) ||
      !leaf.chain ||
      leaf.chain.device.deviceId !== caller.device.id ||
      leaf.chain.device.dskGeneration !== caller.device.dskGeneration
    ) {
      throw new ApiError('IllegalAdd', 403, 'the tree must hold exactly the caller device with its current chain')
    }
    const ext = insp.extensions
    if (
      ext.types.length !== GROUP_CONTEXT_EXTENSIONS.length ||
      ext.types.some((t, i) => t !== GROUP_CONTEXT_EXTENSIONS[i]) ||
      !bytesEqual(ext.externalSenders, deps.signer.externalSender) ||
      !bytesEqual(ext.requiredCapabilities, REQUIRED_CAPABILITIES)
    ) {
      throw new ApiError('InvalidCommit', 400, 'group context extensions differ from §12.6')
    }
    const d = insp.descriptor
    if (
      !d ||
      d.kind !== group.kind ||
      d.guildId !== group.guildId ||
      d.channelId !== (group.kind === 'public_set' ? null : group.channelId) ||
      d.historyVisibility !== group.historyVisibility ||
      d.createdByUserId !== caller.userId
    ) {
      throw new ApiError('InvalidCommit', 400, 'the group descriptor does not match the group')
    }

    const ctx = parseGroupInfoContext(input.groupInfo)
    await r.updateGroup(group.groupId, {
      status: 'active',
      epoch: 0,
      groupInfo: input.groupInfo,
      ratchetTree: input.ratchetTree,
      epochStartedAt: now,
      lastCommitRemoved: false,
    })
    await r.insertGroupEpoch({
      groupId: group.groupId,
      epoch: 0,
      groupInfo: input.groupInfo,
      ratchetTree: input.ratchetTree,
      treeHash: ctx.treeHash,
      confirmedTranscriptHash: ctx.confirmedTranscriptHash,
    })
    await r.replaceMembers(group.groupId, [
      { leafIndex: 0, deviceId: caller.device.id, userId: caller.userId, credentialIdentity: `${caller.userId}:${caller.device.id}`, signatureKey: leaf.signatureKey },
    ])
    await r.deleteBatchesOfGroup(group.groupId)
    const active: GroupRow = { ...group, status: 'active', epoch: 0, groupInfo: input.groupInfo, ratchetTree: input.ratchetTree, epochStartedAt: now }
    // §12.7.7: Adds for the other reader devices (channel, dm). public_set devices join on first open.
    if (group.kind !== 'public_set') await queueAddsForReaders(r, out, active, 'create')
    await emitToGroup(r, out, active, 'MLS_GROUP_UPDATE', toWireGroup(active, false))
    out.wakeGroup(group.groupId)
    return toWireGroup(active, true)
  })
}
