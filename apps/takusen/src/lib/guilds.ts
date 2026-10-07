/**
 * Guild read models for /api/v1: loads rows and shapes them into the wire
 * types via `wire.ts`. Voice states and presences are gateway-owned Redis
 * keys (contract §5); Takusen only reads them to fill GuildFull.
 *
 * It also holds the one call site of the DS membership seam for the content
 * routes (`membershipChanged`, `wakeAfterCommit`, §12.18), and the change
 * that each route trigger gives (`MembershipTriggers`).
 */
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import type {
  Channel,
  GuildFull,
  HistoryVisibility,
  Member,
  Presence,
  PresenceStatus,
  User,
  VoiceState,
} from '@hachiman/client/types'

import { db, type Tx } from '@/db/client'
import {
  channels,
  guildMembers,
  guilds,
  memberRoles,
  mlsGroups,
  permissionOverwrites,
  roles,
  users,
} from '@/db/schema'
import { NotFoundError } from '@/lib/errors'
import { publishToGuild, publishToUser, redis } from '@/lib/events'
import { publishInviteDeletes, revokeAdminInvitesOfNonAdmins } from '@/lib/invite-limits'
import { toB64 } from '@/lib/mls/bytes'
import { discardMembershipWork, onMembershipChange, wakeScheduler, type MembershipChange } from '@/lib/mls/membership'
import { deleteObjects } from '@/lib/storage'
import { deleteAttachmentRows } from '@/lib/uploads'
import {
  assembleGuildFull,
  DEFAULT_PUBLIC_HISTORY_VISIBILITY,
  toChannel,
  toMember,
  toUser,
  type GroupVisibility,
  type UserLike,
  withParentGroups,
} from '@/lib/wire'

// MARK: - DS membership seam (§12.18)

export type { MembershipChange }

/** The DS calls of a content route. Tests replace them with `setMembershipSeam`. */
export interface MembershipSeam {
  change(tx: Tx, change: MembershipChange, actorDeviceId: string | null): Promise<void>
  /** After the commit. */
  wake(tx: Tx): Promise<void>
  /** After a rollback: drop the work of the transaction unpublished. */
  discard(tx: Tx): void
}

const dsSeam: MembershipSeam = { change: onMembershipChange, wake: wakeScheduler, discard: discardMembershipWork }
let seam: MembershipSeam = dsSeam

/** Tests only: record the calls instead of running the DS (null restores it). */
export function setMembershipSeam(s: MembershipSeam | null): void {
  seam = s ?? dsSeam
}

/** Call inside the route transaction: after the write, or before the row delete for deletes. */
export async function membershipChanged(
  tx: Tx,
  changes: MembershipChange | readonly MembershipChange[],
  actorDeviceId: string | null,
): Promise<void> {
  const list: readonly MembershipChange[] = Array.isArray(changes) ? changes : [changes as MembershipChange]
  for (const c of list) await seam.change(tx, c, actorDeviceId)
}

/**
 * Call after the transaction commits: signs the proposals, publishes the DS
 * events of the transaction and wakes the scheduler. A failure is logged: the
 * write committed, and the scheduler picks up the queued items on its tick.
 */
export async function wakeAfterCommit(tx: Tx | undefined): Promise<void> {
  if (!tx) return
  try {
    await seam.wake(tx)
  } catch (err) {
    console.error('[guilds] wakeScheduler failed', err)
  }
}

/** Call after the transaction rolls back: the DS work of the transaction is dropped unpublished. */
export function discardAfterRollback(tx: Tx | undefined): void {
  if (tx) seam.discard(tx)
}

/**
 * `db.transaction` for a route that calls `membershipChanged`. It wakes the
 * scheduler for this transaction after the commit. After a rollback it drops
 * the DS work of the transaction.
 */
export async function membershipTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return membershipTransactionWith((f) => db.transaction(f), fn)
}

/** `membershipTransaction` over any transaction runner. Tests pass a fake one. */
export async function membershipTransactionWith<T>(run: (fn: (tx: Tx) => Promise<T>) => Promise<T>, fn: (tx: Tx) => Promise<T>): Promise<T> {
  let handle: Tx | undefined
  let result: T
  try {
    result = await run(async (tx) => {
      handle = tx
      return fn(tx)
    })
  } catch (err) {
    discardAfterRollback(handle)
    throw err
  }
  await wakeAfterCommit(handle)
  return result
}

/** The DS change of each content route trigger (§12.18). One place, so the routes and the tests agree. */
export const MembershipTriggers = {
  guildCreated: (guildId: string): MembershipChange => ({ kind: 'guild_created', guildId }),
  guildDeleted: (guildId: string): MembershipChange => ({ kind: 'guild_deleted', guildId }),
  /** Invite accept. */
  memberJoined: (guildId: string, userId: string): MembershipChange => ({ kind: 'guild_member_added', guildId, userId }),
  /** Kick and leave. */
  memberLeft: (guildId: string, userId: string): MembershipChange => ({ kind: 'guild_member_removed', guildId, userId }),
  memberRolesEdited: (guildId: string, userId: string): MembershipChange => ({ kind: 'member_roles_changed', guildId, userId }),
  /** Role create, edit and reorder. */
  roleChanged: (guildId: string, roleId: string): MembershipChange => ({ kind: 'role_changed', guildId, roleId }),
  roleDeleted: (guildId: string, roleId: string): MembershipChange => ({ kind: 'role_deleted', guildId, roleId }),
  /** Overwrite PUT and DELETE. */
  overwritesChanged: (channelId: string): MembershipChange => ({ kind: 'overwrites_changed', channelId }),
  channelCreated: (channelId: string): MembershipChange => ({ kind: 'channel_created', channelId }),
  channelDeleted: (guildId: string, channelId: string): MembershipChange => ({ kind: 'channel_deleted', guildId, channelId }),
  dmCreated: (channelId: string): MembershipChange => ({ kind: 'dm_created', channelId }),
  /** Admin user delete, before the user row is deleted. */
  userDeleted: (userId: string): MembershipChange => ({ kind: 'user_deleted', userId }),
  /** Password reset: every device of the user, reason password_reset. */
  passwordReset: (userId: string): MembershipChange => ({ kind: 'devices_revoked', userId, deviceIds: 'all', reason: 'password_reset' }),
} as const

// MARK: - MLS group fields of the wire shapes

type Executor = typeof db | Tx

/** History visibility by base64url group id, for `Channel.historyVisibility`. */
export async function groupVisibility(groupIds: (Uint8Array | null)[], executor: Executor = db): Promise<GroupVisibility> {
  const ids = groupIds.filter((g): g is Uint8Array => g !== null)
  if (ids.length === 0) return new Map()
  const rows = await executor
    .select({ groupId: mlsGroups.groupId, historyVisibility: mlsGroups.historyVisibility })
    .from(mlsGroups)
    .where(inArray(mlsGroups.groupId, ids))
  return new Map(rows.map((r) => [toB64(r.groupId), r.historyVisibility]))
}

/** The visibility of the guild's current (newest non-retired) public_set group. */
export async function publicHistoryVisibility(guildId: string, executor: Executor = db): Promise<HistoryVisibility> {
  const [row] = await executor
    .select({ historyVisibility: mlsGroups.historyVisibility })
    .from(mlsGroups)
    .where(and(eq(mlsGroups.guildId, guildId), eq(mlsGroups.kind, 'public_set'), ne(mlsGroups.status, 'retired')))
    .orderBy(desc(mlsGroups.generation))
    .limit(1)
  return row?.historyVisibility ?? DEFAULT_PUBLIC_HISTORY_VISIBILITY
}

/** The `users` columns `toUser` needs. */
export const userColumns = {
  id: users.id,
  displayName: users.displayName,
  name: users.name,
  email: users.email,
  image: users.image,
}

export async function getUserById(id: string): Promise<UserLike | null> {
  const [row] = await db.select(userColumns).from(users).where(eq(users.id, id)).limit(1)
  return row ?? null
}

export async function requireUserById(id: string): Promise<UserLike> {
  const user = await getUserById(id)
  if (!user) throw new NotFoundError('Unknown user')
  return user
}

export async function loadGuildFull(guildId: string, viewerId: string): Promise<GuildFull> {
  const [guild] = await db.select().from(guilds).where(eq(guilds.id, guildId)).limit(1)
  if (!guild) throw new NotFoundError('Unknown guild')
  const [roleRows, channelRows, overwrites, members, memberRoleRows] = await Promise.all([
    db.select().from(roles).where(eq(roles.guildId, guildId)).orderBy(asc(roles.position)),
    db
      .select()
      .from(channels)
      .where(eq(channels.guildId, guildId))
      .orderBy(asc(channels.position), asc(channels.createdAt)),
    db
      .select({ ow: permissionOverwrites })
      .from(permissionOverwrites)
      .innerJoin(channels, eq(channels.id, permissionOverwrites.channelId))
      .where(eq(channels.guildId, guildId))
      .then((rows) => rows.map((r) => r.ow)),
    db
      .select({ member: guildMembers, user: userColumns })
      .from(guildMembers)
      .innerJoin(users, eq(users.id, guildMembers.userId))
      .where(eq(guildMembers.guildId, guildId))
      .orderBy(asc(guildMembers.joinedAt)),
    db
      .select({ userId: memberRoles.userId, roleId: memberRoles.roleId })
      .from(memberRoles)
      .where(eq(memberRoles.guildId, guildId)),
  ])
  const [voiceStates, presences, groups, publicVisibility] = await Promise.all([
    readVoiceStates(guildId),
    readPresences(members.map((m) => m.member.userId)),
    groupVisibility(channelRows.map((c) => c.mlsGroupId)),
    publicHistoryVisibility(guildId),
  ])
  return assembleGuildFull({
    guild,
    roles: roleRows,
    channels: channelRows,
    overwrites,
    members,
    memberRoles: memberRoleRows,
    viewerId,
    voiceStates,
    presences,
    groups,
    publicHistoryVisibility: publicVisibility,
  })
}

/** `voice:{guildId}`, minus entries whose gateway session has expired. */
async function readVoiceStates(guildId: string): Promise<VoiceState[]> {
  const r = redis()
  const states = Object.values(await r.hgetall(`voice:${guildId}`)).map(
    (json) => JSON.parse(json) as VoiceState,
  )
  if (states.length === 0) return []
  const alive = await Promise.all(states.map((s) => r.exists(`session:${s.sessionId}`)))
  return states.filter((_, i) => alive[i] === 1)
}

/** Online presences for `userIds` (absent key ⇒ offline, omitted). */
async function readPresences(userIds: string[]): Promise<Presence[]> {
  if (userIds.length === 0) return []
  const statuses = await redis().mget(userIds.map((id) => `presence:${id}`))
  const out: Presence[] = []
  statuses.forEach((status, i) => {
    if (status && status !== 'offline') {
      out.push({ userId: userIds[i], status: status as PresenceStatus })
    }
  })
  return out
}

export async function loadMember(guildId: string, userId: string): Promise<Member> {
  const [row] = await db
    .select({ member: guildMembers, user: userColumns })
    .from(guildMembers)
    .innerJoin(users, eq(users.id, guildMembers.userId))
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .limit(1)
  if (!row) throw new NotFoundError('Unknown member')
  const roleRows = await db
    .select({ roleId: memberRoles.roleId })
    .from(memberRoles)
    .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.userId, userId)))
  return toMember(row.member, row.user, roleRows.map((r) => r.roleId))
}

/** Every guild membership of `userId`, as full Members (roles included). */
export async function loadMemberships(userId: string): Promise<Member[]> {
  const [rows, roleRows] = await Promise.all([
    db
      .select({ member: guildMembers, user: userColumns })
      .from(guildMembers)
      .innerJoin(users, eq(users.id, guildMembers.userId))
      .where(eq(guildMembers.userId, userId)),
    db
      .select({ guildId: memberRoles.guildId, roleId: memberRoles.roleId })
      .from(memberRoles)
      .where(eq(memberRoles.userId, userId)),
  ])
  return rows.map(({ member, user }) =>
    toMember(
      member,
      user,
      roleRows.filter((r) => r.guildId === member.guildId).map((r) => r.roleId),
    ),
  )
}

export async function listMembers(guildId: string): Promise<Member[]> {
  const [rows, roleRows] = await Promise.all([
    db
      .select({ member: guildMembers, user: userColumns })
      .from(guildMembers)
      .innerJoin(users, eq(users.id, guildMembers.userId))
      .where(eq(guildMembers.guildId, guildId))
      .orderBy(asc(guildMembers.joinedAt)),
    db
      .select({ userId: memberRoles.userId, roleId: memberRoles.roleId })
      .from(memberRoles)
      .where(eq(memberRoles.guildId, guildId)),
  ])
  return rows.map(({ member, user }) =>
    toMember(
      member,
      user,
      roleRows.filter((r) => r.userId === member.userId).map((r) => r.roleId),
    ),
  )
}

/** Guild channels by id, with their overwrites, in the given id order. */
export async function loadChannels(ids: string[]): Promise<Channel[]> {
  if (ids.length === 0) return []
  const [own, overwrites] = await Promise.all([
    db.select().from(channels).where(inArray(channels.id, ids)),
    db.select().from(permissionOverwrites).where(inArray(permissionOverwrites.channelId, ids)),
  ])
  const parentIds = own.flatMap((c) => (c.type === 'thread' && c.parentId ? [c.parentId] : []))
  const parents = parentIds.length > 0 ? await db.select().from(channels).where(inArray(channels.id, parentIds)) : []
  const rows = withParentGroups(own, parents)
  const groups = await groupVisibility(rows.map((c) => c.mlsGroupId))
  const byId = new Map(rows.map((c) => [c.id, toChannel(c, overwrites, groups)]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

export async function loadChannel(id: string): Promise<Channel> {
  const [channel] = await loadChannels([id])
  if (!channel) throw new NotFoundError('Unknown channel')
  return channel
}

/**
 * Kick / leave: drop the membership (member_roles cascade), revoke the
 * permanent invites and the invites with history of the removed user (§4),
 * queue the DS Removes in the same transaction, and tell the guild and the
 * removed user. The caller has already checked permissions.
 */
export async function removeMember(guildId: string, userId: string, actorDeviceId: string | null): Promise<void> {
  const user = await getUserById(userId)
  if (!user) throw new NotFoundError('Unknown member')
  const revoked = await membershipTransaction(async (tx) => {
    const deleted = await tx
      .delete(guildMembers)
      .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
      .returning({ userId: guildMembers.userId })
    if (deleted.length === 0) throw new NotFoundError('Unknown member')
    const revoked = await revokeAdminInvitesOfNonAdmins(tx, guildId)
    await membershipChanged(tx, MembershipTriggers.memberLeft(guildId, userId), actorDeviceId)
    return revoked
  })
  await publishToGuild(guildId, 'GUILD_MEMBER_REMOVE', { guildId, user: toUser(user) })
  await publishToUser(userId, 'GUILD_DELETE', { id: guildId })
  await publishInviteDeletes(guildId, revoked)
}

/**
 * Deletes a guild in `tx` (rows cascade) and returns its attachment keys for
 * deleteObjects after commit. The DS retires the guild's groups first, in the
 * same transaction (§12.18 `guild_deleted`). Throws NotFound for an unknown guild.
 */
export async function deleteGuildRows(tx: Tx, guildId: string, actorDeviceId: string | null): Promise<string[]> {
  const keys = await deleteAttachmentRows(tx, { guildId })
  await membershipChanged(tx, MembershipTriggers.guildDeleted(guildId), actorDeviceId)
  const deleted = await tx.delete(guilds).where(eq(guilds.id, guildId)).returning({ id: guilds.id })
  if (deleted.length === 0) throw new NotFoundError('Unknown guild')
  return keys
}

/** Owner or admin delete: rows, then GUILD_DELETE, then (best effort) objects. */
export async function deleteGuild(guildId: string, actorDeviceId: string | null): Promise<void> {
  const keys = await membershipTransaction((tx) => deleteGuildRows(tx, guildId, actorDeviceId))
  await publishToGuild(guildId, 'GUILD_DELETE', { id: guildId })
  await deleteObjects(keys)
}

/** USER_UPDATE to the user, and GUILD_MEMBER_UPDATE (full Member) to each of its guilds. */
export async function publishUserUpdate(user: User): Promise<void> {
  await publishToUser(user.id, 'USER_UPDATE', user)
  const memberships = await loadMemberships(user.id)
  await Promise.all(memberships.map((m) => publishToGuild(m.guildId, 'GUILD_MEMBER_UPDATE', m)))
}
