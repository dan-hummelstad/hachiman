/**
 * Permission checks for /api/v1 routes. Loads the caller's guild membership,
 * roles and channel overwrites from Postgres and computes permissions with the
 * shared `@hachiman/client/permissions` algorithm (contract §2), so Takusen,
 * the gateway and the UI all agree on who may do what. Reader sets come from
 * `lib/mls/readers.ts` (§12.6).
 */
import { and, eq } from 'drizzle-orm'
import {
  computeBasePermissions,
  computeChannelPermissions,
  DM_PERMISSIONS,
  has,
  highestRolePosition,
  Permissions,
} from '@hachiman/client/permissions'
import type { GatewayEventName, GatewayEvents } from '@hachiman/client/types'

import { db } from '@/db/client'
import {
  channels,
  dmParticipants,
  guildMembers,
  guilds,
  memberRoles,
  permissionOverwrites,
  roles,
  type ChannelRow,
  type GuildRow,
  type PermissionOverwriteRow,
  type RoleRow,
} from '@/db/schema'
import { MissingPermissionsError, NotFoundError } from '@/lib/errors'
import { publishToGuild, publishToUser } from '@/lib/events'
import { assertId } from '@/lib/ids'
import { DEVICE_HEADER, requireDevice } from '@/lib/mls/device-auth'
import { channelReaders, isPublicChannel } from '@/lib/mls/readers'
import { toOverwrite } from '@/lib/wire'

// MARK: - Readers (§12.6). The one implementation is lib/mls/readers.ts.

/** User ids with VIEW_CHANNEL on a guild text channel, or the participants of a DM. */
export async function readersOfChannel(channelId: string): Promise<Set<string>> {
  return channelReaders(db, channelId)
}

/** True when the guild text channel uses the guild's public_set group (§12.6 rule). */
export async function channelIsPublic(channelId: string): Promise<boolean> {
  return isPublicChannel(db, channelId)
}

/**
 * The `X-Hachiman-Device` of a content route, as the actor device of its
 * membership change (the preferred assignee of a group create, §12.7.7).
 * Optional on these routes. When it is present, it must be an active device
 * of the caller.
 */
export async function actorDeviceId(req: Request, userId: string): Promise<string | null> {
  if (!req.headers.get(DEVICE_HEADER)) return null
  return (await requireDevice(req, userId)).id
}

export interface GuildAccess {
  guild: GuildRow
  userId: string
  /** The caller's role ids, excluding @everyone. */
  roleIds: string[]
  roles: Map<string, RoleRow>
  /** Guild-level (base) permissions. */
  permissions: number
}

export async function loadGuildAccess(guildId: string, userId: string): Promise<GuildAccess> {
  assertId(guildId, 'guild')
  const [guild] = await db.select().from(guilds).where(eq(guilds.id, guildId)).limit(1)
  if (!guild) throw new NotFoundError('Unknown guild')
  const [member] = await db
    .select({ userId: guildMembers.userId })
    .from(guildMembers)
    .where(and(eq(guildMembers.guildId, guildId), eq(guildMembers.userId, userId)))
    .limit(1)
  if (!member) throw new MissingPermissionsError('Not a member of this guild')

  const [roleRows, mine] = await Promise.all([
    db.select().from(roles).where(eq(roles.guildId, guildId)),
    db
      .select({ roleId: memberRoles.roleId })
      .from(memberRoles)
      .where(and(eq(memberRoles.guildId, guildId), eq(memberRoles.userId, userId))),
  ])
  const roleMap = new Map(roleRows.map((r) => [r.id, r]))
  const roleIds = mine.map((r) => r.roleId)
  const permissions = computeBasePermissions(guild, { user: { id: userId }, roles: roleIds }, roleMap)
  return { guild, userId, roleIds, roles: roleMap, permissions }
}

export function requirePermission(perms: number, bit: number): void {
  if (!has(perms, bit)) throw new MissingPermissionsError()
}

/** Owner or ADMINISTRATOR: exempt from role hierarchy and grant limits. */
export function isPrivileged(access: GuildAccess): boolean {
  return has(access.permissions, Permissions.ADMINISTRATOR)
}

/** Role hierarchy: may only act on positions strictly below the caller's highest role. */
export function requireAbovePosition(access: GuildAccess, position: number): void {
  if (isPrivileged(access)) return
  if (position >= highestRolePosition({ roles: access.roleIds }, access.roles)) {
    throw new MissingPermissionsError('Role is not below your highest role')
  }
}

/** Callers can only grant (or deny) permission bits they hold themselves. */
export function requireGrantable(access: GuildAccess, bits: number): void {
  if (isPrivileged(access)) return
  if (bits & ~access.permissions) {
    throw new MissingPermissionsError('Cannot grant permissions you do not have')
  }
}

export interface ChannelAccess {
  channel: ChannelRow
  /** null for DMs. */
  guild: GuildAccess | null
  overwrites: PermissionOverwriteRow[]
  /** DM participants (empty for guild channels). */
  participantIds: string[]
  permissions: number
}

/** Loads a channel the caller can VIEW; throws 404/403 otherwise. */
export async function loadChannelAccess(channelId: string, userId: string): Promise<ChannelAccess> {
  assertId(channelId, 'channel')
  const [channel] = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1)
  if (!channel) throw new NotFoundError('Unknown channel')

  if (channel.guildId === null) {
    const rows = await db
      .select({ userId: dmParticipants.userId })
      .from(dmParticipants)
      .where(eq(dmParticipants.channelId, channelId))
    const participantIds = rows.map((r) => r.userId)
    if (!participantIds.includes(userId)) throw new MissingPermissionsError()
    return { channel, guild: null, overwrites: [], participantIds, permissions: DM_PERMISSIONS }
  }

  const guild = await loadGuildAccess(channel.guildId, userId)
  const overwrites = await db
    .select()
    .from(permissionOverwrites)
    .where(eq(permissionOverwrites.channelId, channelId))
  const permissions = computeChannelPermissions(
    guild.guild,
    { user: { id: userId }, roles: guild.roleIds },
    guild.roles,
    { permissionOverwrites: overwrites.map(toOverwrite) },
  )
  if (!has(permissions, Permissions.VIEW_CHANNEL)) throw new MissingPermissionsError()
  return { channel, guild, overwrites, participantIds: [], permissions }
}

/** Guild channel → `guild:{id}` scoped by channelId; DM → every participant's `user:{id}`. */
export async function publishToChannel<T extends GatewayEventName>(
  access: Pick<ChannelAccess, 'channel' | 'participantIds'>,
  t: T,
  d: GatewayEvents[T],
): Promise<void> {
  const { channel } = access
  if (channel.guildId !== null) {
    await publishToGuild(channel.guildId, t, d, channel.id)
    return
  }
  await Promise.all(access.participantIds.map((id) => publishToUser(id, t, d)))
}
