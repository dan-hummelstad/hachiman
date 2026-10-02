/**
 * Membership changes → DS work (docs/gateway-protocol.md §12.18).
 *
 * Content routes call `onMembershipChange` inside their transaction, after
 * the write, and `wakeScheduler` after the commit (`discardMembershipWork`
 * after a rollback). The change queues Removes
 * and Adds, allocates and retires groups, and moves channels between the
 * `public_set` group and their own group (§12.6). `wakeScheduler` then signs
 * the DS proposals for the new items (one per item and epoch, §12.7.4),
 * publishes them as MLS_HANDSHAKE with the other events of the change, and
 * wakes the batch scheduler.
 */
import type { Tx } from '@/db/client'

import { hasTextGroup } from '@/lib/channel-types'

import { fromB64 } from './bytes'
import { CipherSuite } from './crypto'
import { dsDeps, lightDeps, type LightDeps } from './context'
import { emitUserKeysUpdate, flushOutbox, Outbox } from './events'
import { activeDevicesOf, allocateGroup, chooseSuite, retireGroup } from './groups'
import { signPendingProposals } from './proposals'
import { isPublicFrom, readersOfGroup } from './readers'
import { queueRemove, reconcileGroup } from './reconcile'
import { drizzleMlsRepo } from './repo.drizzle'
import type { ChannelInfo, GroupRow, MlsRepo, RevokeReason } from './repo'

export type RevocationReason = RevokeReason

export type MembershipChange =
  | { kind: 'guild_created'; guildId: string }
  | { kind: 'guild_member_added' | 'guild_member_removed' | 'member_roles_changed'; guildId: string; userId: string }
  | { kind: 'role_changed' | 'role_deleted'; guildId: string; roleId: string }
  | { kind: 'overwrites_changed' | 'channel_created'; channelId: string }
  | { kind: 'channel_deleted'; guildId: string; channelId: string }
  | { kind: 'guild_deleted'; guildId: string }
  | { kind: 'dm_created'; channelId: string }
  | { kind: 'user_deleted'; userId: string }
  | { kind: 'devices_revoked'; userId: string; deviceIds: string[] | 'all'; reason: RevocationReason }

// MARK: - The seam

/**
 * Outboxes of open transactions, keyed by the transaction handle. After the
 * commit, `wakeScheduler(tx)` flushes and drops the entry. After a rollback,
 * `discardMembershipWork(tx)` drops it, so nothing of a rolled-back
 * transaction is ever published.
 */
const outboxes = new Map<object, Outbox>()

function outboxFor(tx: object): Outbox {
  let out = outboxes.get(tx)
  if (!out) outboxes.set(tx, (out = new Outbox()))
  return out
}

/** Call inside the route transaction, after the write. */
export async function onMembershipChange(tx: Tx, change: MembershipChange, actorDeviceId: string | null): Promise<void> {
  await recordMembershipChange(tx, drizzleMlsRepo(tx), lightDeps(), change, actorDeviceId)
}

/** `onMembershipChange` with an explicit repo and deps. `key` is the transaction handle. Tests use the in-memory repo. */
export async function recordMembershipChange(key: object, repo: MlsRepo, deps: LightDeps, change: MembershipChange, actorDeviceId: string | null): Promise<void> {
  await onMembershipChangeWith(repo, deps, outboxFor(key), change, actorDeviceId)
}

/** Call after the transaction commits: flushes the work of that transaction only. */
export async function wakeScheduler(tx: Tx): Promise<void> {
  const own = outboxes.get(tx)
  outboxes.delete(tx)
  if (!own) return
  await flushWithProposals(drizzleMlsRepo(), own)
}

/** Call after the transaction rolls back: drops its work unpublished. */
export function discardMembershipWork(tx: object): void {
  outboxes.delete(tx)
}

/** True while the transaction has recorded work that is neither flushed nor discarded. */
export function hasMembershipWork(tx: object): boolean {
  return outboxes.has(tx)
}

/**
 * Publishes the events of `out`, then signs the proposals of the groups that
 * got new items and publishes them, then wakes the scheduler.
 */
export async function flushWithProposals(repo: MlsRepo, out: Outbox, deps?: Parameters<typeof signPendingProposals>[1]): Promise<void> {
  const proposals = new Outbox()
  if (out.wake.size > 0) {
    try {
      const d = deps ?? (await dsDeps())
      for (const g of out.wake) {
        const id = fromB64(g)
        if (id) await signPendingProposals(repo, d, proposals, id)
      }
    } catch (err) {
      // The scheduler signs the missing proposals on its next tick.
      console.error('[mls] proposal signing failed', err)
    }
  }
  const all = new Outbox()
  all.merge(out)
  all.events.push(...proposals.events)
  await flushOutbox(all)
}

// MARK: - Implementation

export async function onMembershipChangeWith(repo: MlsRepo, deps: LightDeps, out: Outbox, change: MembershipChange, actorDeviceId: string | null): Promise<void> {
  const reason = change.kind
  const now = deps.now()
  switch (change.kind) {
    case 'guild_created':
      await ensurePublicSet(repo, deps, out, change.guildId, actorDeviceId)
      await reconcileGuild(repo, deps, out, change.guildId, reason, actorDeviceId)
      return
    case 'guild_member_added':
    case 'guild_member_removed':
    case 'member_roles_changed':
    case 'role_changed':
    case 'role_deleted':
      await reconcileGuild(repo, deps, out, change.guildId, reason, actorDeviceId)
      return
    case 'overwrites_changed':
    case 'channel_created': {
      const channel = await repo.getChannel(change.channelId)
      if (channel && hasTextGroup(channel.type) && channel.guildId) {
        await reclassifyChannel(repo, deps, out, channel, reason, actorDeviceId)
      }
      return
    }
    case 'channel_deleted':
      for (const g of await repo.listGroupsByChannel(change.channelId)) await retireGroup(repo, out, g)
      return
    case 'guild_deleted':
      for (const g of await repo.listGroupsByGuild(change.guildId)) await retireGroup(repo, out, g)
      return
    case 'dm_created': {
      const channel = await repo.getChannel(change.channelId)
      if (!channel || (channel.type !== 'dm' && channel.type !== 'group_dm') || channel.mlsGroupId) return
      const g = await allocateGroup(repo, deps, out, { kind: 'dm', scopeId: channel.id, guildId: null, channelId: channel.id, historyVisibility: 'joined' }, actorDeviceId)
      await repo.setChannelGroup(channel.id, g.groupId)
      return
    }
    case 'user_deleted':
      await queueRemovesOfUser(repo, out, change.userId, reason)
      return
    case 'devices_revoked':
      await revokeDevicesWith(repo, out, { userId: change.userId, devices: change.deviceIds, reason: change.reason, now })
      return
  }
}

/** The newest non-retired public_set group of the guild. Allocates one when there is none. */
async function ensurePublicSet(repo: MlsRepo, deps: LightDeps, out: Outbox, guildId: string, actorDeviceId: string | null): Promise<GroupRow> {
  const sets = (await repo.listGroupsByGuild(guildId)).filter((g) => g.kind === 'public_set')
  const current = sets.filter((g) => g.status !== 'retired').sort((a, b) => b.generation - a.generation)[0]
  if (current) return current
  const previous = sets.sort((a, b) => b.generation - a.generation)[0]
  return allocateGroup(
    repo,
    deps,
    out,
    { kind: 'public_set', scopeId: guildId, guildId, channelId: null, historyVisibility: previous?.historyVisibility ?? 'shared' },
    actorDeviceId,
  )
}

async function reconcileGuild(repo: MlsRepo, deps: LightDeps, out: Outbox, guildId: string, reason: string, actorDeviceId: string | null): Promise<void> {
  const now = deps.now()
  for (const g of await repo.listGroupsByGuild(guildId)) {
    if (g.kind === 'public_set') await reconcileGroup(repo, out, g, reason, now)
  }
  for (const channel of await repo.listGuildTextChannels(guildId)) {
    await reclassifyChannel(repo, deps, out, channel, reason, actorDeviceId)
  }
}

/**
 * §12.6 channel moves. A public channel uses the public_set group, and its own
 * `channel` group (if any) retires. A private channel uses its own group: a new
 * generation when it has none, else the group's readers are reconciled.
 */
async function reclassifyChannel(repo: MlsRepo, deps: LightDeps, out: Outbox, channel: ChannelInfo, reason: string, actorDeviceId: string | null): Promise<void> {
  const guildId = channel.guildId!
  const data = await repo.getGuildPermissionData(guildId)
  if (!data) return
  const overwrites = await repo.getChannelOverwrites(channel.id)
  const isPublic = isPublicFrom(guildId, data.roles.get(guildId)?.permissions ?? 0, overwrites)
  // FOR UPDATE: a createGroup of this group that runs now computed its readers before this
  // change committed. The lock waits for it, so the reconcile below sees the group active
  // and queues the Adds that the create missed.
  const current = channel.mlsGroupId ? await repo.lockGroup(channel.mlsGroupId) : null

  if (isPublic) {
    const set = await ensurePublicSet(repo, deps, out, guildId, actorDeviceId)
    if (current?.kind === 'channel') await retireGroup(repo, out, current)
    if (!current || current.kind !== 'public_set' || current.status === 'retired' || !sameBytes(current.groupId, set.groupId)) {
      await repo.setChannelGroup(channel.id, set.groupId)
    }
    return
  }
  if (current?.kind === 'channel' && current.status !== 'retired') {
    await reconcileGroup(repo, out, current, reason, deps.now())
    return
  }
  const previous = (await repo.listGroupsByChannel(channel.id)).filter((g) => g.kind === 'channel').sort((a, b) => b.generation - a.generation)[0]
  const g = await allocateGroup(
    repo,
    deps,
    out,
    { kind: 'channel', scopeId: channel.id, guildId, channelId: channel.id, historyVisibility: previous?.historyVisibility ?? 'joined' },
    actorDeviceId,
  )
  await repo.setChannelGroup(channel.id, g.groupId)
}

/**
 * §12.15: a group never changes suite. When the daily sweep finds that the
 * enabled suite 83 is now possible for every reader device of a suite-1 group,
 * it makes a new generation of the group, as a channel move does, and retires
 * the old one. Returns the new group, or null when no upgrade is possible.
 */
export async function upgradeSuite(repo: MlsRepo, deps: LightDeps, out: Outbox, group: GroupRow): Promise<GroupRow | null> {
  if (group.status !== 'active' || group.cipherSuite !== CipherSuite.X25519_AES128GCM_SHA256_ED25519) return null
  const readers = await readersOfGroup(repo, group)
  const devices = await activeDevicesOf(repo, readers)
  const suite = await chooseSuite(repo, deps, devices.map((d) => d.id))
  if (suite !== CipherSuite.XWING_AES256GCM_SHA512_ED25519) return null
  const next = await allocateGroup(
    repo,
    deps,
    out,
    { kind: group.kind, scopeId: group.scopeId, guildId: group.guildId, channelId: group.channelId, historyVisibility: group.historyVisibility },
    null,
  )
  const pointing =
    group.kind === 'public_set' && group.guildId
      ? (await repo.listGuildTextChannels(group.guildId)).filter((c) => c.mlsGroupId && sameBytes(c.mlsGroupId, group.groupId))
      : group.channelId
        ? [await repo.getChannel(group.channelId)].filter((c): c is ChannelInfo => !!c && !!c.mlsGroupId && sameBytes(c.mlsGroupId, group.groupId))
        : []
  for (const c of pointing) await repo.setChannelGroup(c.id, next.groupId)
  await retireGroup(repo, out, group)
  return next
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0
}

/**
 * §12.18 `user_deleted`: before the user row goes, queue a Remove keyed by
 * leaf index for every leaf of the user in every group. The FKs then set the
 * user and device of the roster and pending rows to null, and the Removes stay.
 */
async function queueRemovesOfUser(repo: MlsRepo, out: Outbox, userId: string, reason: string): Promise<void> {
  const deviceIds = (await repo.listDevices(userId)).map((d) => d.id)
  const leaves = [...(await repo.membershipsOfUser(userId)), ...(await repo.membershipsOfDevices(deviceIds))]
  const groups = new Map<string, GroupRow | null>()
  for (const m of leaves) {
    const key = Buffer.from(m.groupId).toString('hex')
    if (!groups.has(key)) groups.set(key, await repo.getGroup(m.groupId))
    const group = groups.get(key)
    if (group && group.status === 'active') await queueRemove(repo, out, group, m, reason)
  }
}

/**
 * Revokes devices of one user (§12.4, §12.18 `devices_revoked`): status, the
 * revocation row, the key packages, Removes in every group, USER_KEYS_UPDATE and
 * the internal DEVICE_REVOKED. `'all'` is the password reset path: it also sets
 * superseded_at on the current master key, so a bearer token alone cannot
 * replace it (§12.4 "Password reset").
 */
export async function revokeDevicesWith(
  repo: MlsRepo,
  out: Outbox,
  input: { userId: string; devices: string[] | 'all' | { id: string; revocation: Uint8Array | null }[]; reason: RevocationReason; now: Date },
): Promise<string[]> {
  const own = await repo.listDevices(input.userId)
  const wanted =
    input.devices === 'all'
      ? own.map((d) => ({ id: d.id, revocation: null as Uint8Array | null }))
      : input.devices.map((d) => (typeof d === 'string' ? { id: d, revocation: null } : d))
  const revoked: string[] = []
  for (const w of wanted) {
    const device = own.find((d) => d.id === w.id)
    if (!device || device.status === 'revoked') continue
    await repo.updateDevice(device.id, { status: 'revoked', revokedAt: input.now })
    await repo.insertRevocation({ deviceId: device.id, userId: input.userId, reason: input.reason, revocation: w.revocation })
    await repo.deleteDeviceKeyPackages(device.id)
    revoked.push(device.id)
    out.revokedDevices.add(device.id)
  }
  for (const m of await repo.membershipsOfDevices(revoked)) {
    const group = await repo.getGroup(m.groupId)
    if (group?.status === 'active') await queueRemove(repo, out, group, m, `revoked:${input.reason}`)
  }
  if (input.devices === 'all' && input.reason === 'password_reset') await repo.supersedeMasterKey(input.userId, input.now)
  for (const id of revoked) {
    await emitUserKeysUpdate(repo, out, { userId: input.userId, kind: 'device_revoked', deviceId: id })
    out.toDevice(id, 'DEVICE_REVOKED', { deviceId: id })
  }
  return revoked
}
