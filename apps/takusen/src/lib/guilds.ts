/**
 * Guild read models for /api/v1: loads rows and shapes them into the wire
 * types via `wire.ts`. Voice states and presences are gateway-owned Redis
 * keys (contract §5); Takusen only reads them to fill GuildFull.
 */
import { and, asc, eq, inArray } from 'drizzle-orm'
import type {
  Channel,
  GuildFull,
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
  permissionOverwrites,
  roles,
  users,
} from '@/db/schema'
import { NotFoundError } from '@/lib/errors'
import { publishToGuild, publishToUser, redis } from '@/lib/events'
import { deleteObjects } from '@/lib/storage'
import { deleteAttachmentRows } from '@/lib/uploads'
import { assembleGuildFull, toChannel, toMember, toUser, type UserLike } from '@/lib/wire'

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
  const [voiceStates, presences] = await Promise.all([
    readVoiceStates(guildId),
    readPresences(members.map((m) => m.member.userId)),
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
  const [rows, overwrites] = await Promise.all([
    db.select().from(channels).where(inArray(channels.id, ids)),
    db.select().from(permissionOverwrites).where(inArray(permissionOverwrites.channelId, ids)),
  ])
  const byId = new Map(rows.map((c) => [c.id, toChannel(c, overwrites)]))
  return ids.flatMap((id) => byId.get(id) ?? [])
}

export async function loadChannel(id: string): Promise<Channel> {
  const [channel] = await loadChannels([id])
  if (!channel) throw new NotFoundError('Unknown channel')
  return channel
}

/**
 * Kick / leave: drop the membership (member_roles cascade) and tell the guild
 * and the removed user. The caller has already checked permissions.
 */
export async function removeMember(guildId: string, userId: string): Promise<void> {
  const user = await getUserById(userId)
  const deleted = await db
    .delete(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .returning({ userId: guildMembers.userId })
  if (deleted.length === 0 || !user) throw new NotFoundError('Unknown member')
  await publishToGuild(guildId, 'GUILD_MEMBER_REMOVE', { guildId, user: toUser(user) })
  await publishToUser(userId, 'GUILD_DELETE', { id: guildId })
}

/**
 * Deletes a guild in `tx` (rows cascade) and returns its attachment keys for
 * deleteObjects after commit. Throws NotFound for an unknown guild.
 */
export async function deleteGuildRows(tx: Tx, guildId: string): Promise<string[]> {
  const keys = await deleteAttachmentRows(tx, { guildId })
  const deleted = await tx.delete(guilds).where(eq(guilds.id, guildId)).returning({ id: guilds.id })
  if (deleted.length === 0) throw new NotFoundError('Unknown guild')
  return keys
}

/** Owner or admin delete: rows, then GUILD_DELETE, then (best effort) objects. */
export async function deleteGuild(guildId: string): Promise<void> {
  const keys = await db.transaction((tx) => deleteGuildRows(tx, guildId))
  await publishToGuild(guildId, 'GUILD_DELETE', { id: guildId })
  await deleteObjects(keys)
}

/** USER_UPDATE to the user, and GUILD_MEMBER_UPDATE (full Member) to each of its guilds. */
export async function publishUserUpdate(user: User): Promise<void> {
  await publishToUser(user.id, 'USER_UPDATE', user)
  const memberships = await loadMemberships(user.id)
  await Promise.all(memberships.map((m) => publishToGuild(m.guildId, 'GUILD_MEMBER_UPDATE', m)))
}
