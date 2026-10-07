// Discord-style permission bitfield. Contract: docs/gateway-protocol.md §2.
// Go mirror: apps/hachiman-server/pkg/permissions/permissions.go — a Go test
// parses this file, so keep every constant as `NAME: 1 << n,` on its own line.
// ponytail: plain numbers while every bit is < 2^31; move to bigint past that.

import type { Channel, Guild, Member, Role } from './types'

export const Permissions = {
  CREATE_INSTANT_INVITE: 1 << 0,
  KICK_MEMBERS: 1 << 1,
  ADMINISTRATOR: 1 << 3,
  MANAGE_CHANNELS: 1 << 4,
  MANAGE_GUILD: 1 << 5,
  VIEW_CHANNEL: 1 << 10,
  SEND_MESSAGES: 1 << 11,
  MANAGE_MESSAGES: 1 << 13,
  ATTACH_FILES: 1 << 15,
  READ_MESSAGE_HISTORY: 1 << 16,
  CONNECT: 1 << 20,
  SPEAK: 1 << 21,
  MUTE_MEMBERS: 1 << 22,
  DEAFEN_MEMBERS: 1 << 23,
  MOVE_MEMBERS: 1 << 24,
  CHANGE_NICKNAME: 1 << 26,
  MANAGE_NICKNAMES: 1 << 27,
  MANAGE_ROLES: 1 << 28,
  MANAGE_EVENTS: 1 << 29,
} as const

export type PermissionName = keyof typeof Permissions

export const ALL_PERMISSIONS: number = Object.values(Permissions).reduce((a, b) => a | b, 0)
/** Contract §2 name for {@link ALL_PERMISSIONS}. */
export const ALL = ALL_PERMISSIONS

export const DEFAULT_EVERYONE: number =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.ATTACH_FILES |
  Permissions.READ_MESSAGE_HISTORY |
  Permissions.CONNECT |
  Permissions.SPEAK |
  Permissions.CREATE_INSTANT_INVITE |
  Permissions.CHANGE_NICKNAME

export const DM_PERMISSIONS: number =
  Permissions.VIEW_CHANNEL |
  Permissions.SEND_MESSAGES |
  Permissions.ATTACH_FILES |
  Permissions.READ_MESSAGE_HISTORY

export function has(perms: number, bit: number): boolean {
  return (perms & bit) === bit
}

type GuildLike = Pick<Guild, 'id' | 'ownerId'>
type MemberLike = Pick<Member, 'roles'> & { user: { id: string } }
type RoleMap = ReadonlyMap<string, Pick<Role, 'id' | 'permissions'>>

export function computeBasePermissions(guild: GuildLike, member: MemberLike, roles: RoleMap): number {
  if (member.user.id === guild.ownerId) return ALL_PERMISSIONS
  let p = roles.get(guild.id)?.permissions ?? 0 // @everyone role id === guild id
  for (const id of member.roles) p |= roles.get(id)?.permissions ?? 0
  return p & Permissions.ADMINISTRATOR ? ALL_PERMISSIONS : p
}

export function computeChannelPermissions(
  guild: GuildLike,
  member: MemberLike,
  roles: RoleMap,
  channel: Pick<Channel, 'permissionOverwrites'>,
): number {
  const base = computeBasePermissions(guild, member, roles)
  if (base & Permissions.ADMINISTRATOR) return ALL_PERMISSIONS // owner's ALL includes it
  let p = base
  const ows = channel.permissionOverwrites
  const everyone = ows.find(o => o.type === 'role' && o.id === guild.id)
  if (everyone) p = (p & ~everyone.deny) | everyone.allow
  let allow = 0
  let deny = 0
  for (const o of ows) {
    if (o.type === 'role' && o.id !== guild.id && member.roles.includes(o.id)) {
      allow |= o.allow
      deny |= o.deny
    }
  }
  p = (p & ~deny) | allow
  const mine = ows.find(o => o.type === 'member' && o.id === member.user.id)
  if (mine) p = (p & ~mine.deny) | mine.allow
  return p & Permissions.VIEW_CHANNEL ? p : 0
}

const NO_ROLES: RoleMap = new Map()

/** What {@link effectivePermissions} decides from; absent fields mean "not known (yet)". */
export interface PermissionContext {
  guild?: GuildLike | undefined
  /** The current user's membership in `guild`. */
  member?: MemberLike | undefined
  roles?: RoleMap | undefined
  /** Omit for guild-wide (base) permissions. */
  channel?: Pick<Channel, 'guildId' | 'permissionOverwrites'> | undefined
}

/**
 * The current user's permissions from whatever the caller knows: a DM channel grants
 * DM_PERMISSIONS (callers only hold DMs the user is in); an unknown guild or membership grants
 * nothing; otherwise the channel's (or, without a channel, the guild's base) permissions.
 */
export function effectivePermissions({
  guild,
  member,
  roles = NO_ROLES,
  channel,
}: PermissionContext): number {
  if (channel?.guildId === null) return DM_PERMISSIONS
  if (!guild || !member) return 0
  return channel
    ? computeChannelPermissions(guild, member, roles, channel)
    : computeBasePermissions(guild, member, roles)
}

/**
 * The channel whose overwrites decide the permissions of `channel` (contract §2):
 * the parent text channel for a thread, else the channel itself. A thread whose
 * parent is not known returns null: the caller grants nothing.
 */
export function permissionChannel<C extends Pick<Channel, 'type' | 'parentId'>>(
  channel: C,
  lookup: (id: string) => C | undefined,
): C | null {
  if (channel.type !== 'thread') return channel
  return channel.parentId !== null ? (lookup(channel.parentId) ?? null) : null
}

/** Highest role position the member holds (0 = only @everyone). */
export function highestRolePosition(
  member: Pick<Member, 'roles'>,
  roles: ReadonlyMap<string, Pick<Role, 'position'>>,
): number {
  let max = 0
  for (const id of member.roles) max = Math.max(max, roles.get(id)?.position ?? 0)
  return max
}
