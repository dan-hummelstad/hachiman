import { useMemo } from 'react'
import {
  Permissions,
  computeChannelPermissions,
  has,
  type Channel,
  type Role
} from '@hachiman/client'
import { rolesByPositionDesc } from '@/lib/model'
import { useGuildStore } from '@/stores/guildStore'

/** Who can read and who can post in a guild text channel, from its overwrites (plan decisions 7, 8). */
export interface ChannelAccess {
  /** A text channel in which @everyone has no SEND_MESSAGES: an announcement channel. */
  readOnly: boolean
  /** Read only: the roles that can post, highest first. */
  posters: Role[]
  /** @everyone has no VIEW_CHANNEL. */
  restricted: boolean
  /** Restricted: the roles that can see the channel, highest first. */
  viewers: Role[]
}

const OPEN: ChannelAccess = { readOnly: false, posters: [], restricted: false, viewers: [] }

/**
 * The permissions of a member that holds only `roleIds` (no owner, no member overwrite), with the
 * same rules as the client library.
 */
function permsOf(channel: Channel, roles: Map<string, Role>, roleIds: string[]): number {
  const guild = { id: channel.guildId!, ownerId: 'nobody' } // never the member below
  const member = { user: { id: '' }, roles: roleIds }
  return computeChannelPermissions(guild, member, roles, channel)
}

export function channelAccess(
  channel: Channel,
  roles: Map<string, Role> | undefined
): ChannelAccess {
  if (!channel.guildId || !roles || (channel.type !== 'text' && channel.type !== 'pages'))
    return OPEN
  const everyone = permsOf(channel, roles, [])
  const restricted = !has(everyone, Permissions.VIEW_CHANNEL)
  const readOnly =
    channel.type === 'text' && !restricted && !has(everyone, Permissions.SEND_MESSAGES)
  if (!restricted && !readOnly) return OPEN
  const others = rolesByPositionDesc(roles.values()).filter((r) => r.id !== channel.guildId)
  const can = (bit: number): Role[] =>
    others.filter((r) => has(permsOf(channel, roles, [r.id]), bit))
  return {
    readOnly,
    posters: readOnly ? can(Permissions.SEND_MESSAGES) : [],
    restricted,
    viewers: restricted ? can(Permissions.VIEW_CHANNEL) : []
  }
}

export function useChannelAccess(channel: Channel): ChannelAccess {
  const roles = useGuildStore((s) => (channel.guildId ? s.roles.get(channel.guildId) : undefined))
  return useMemo(() => channelAccess(channel, roles), [channel, roles])
}

/** "vexbot and Captain", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
