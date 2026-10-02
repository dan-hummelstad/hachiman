/**
 * Who reads a channel or a group (docs/gateway-protocol.md §12.6). The one
 * Takusen implementation of `channelReaders`; `lib/guild-access.ts` calls it.
 * It uses the §2 algorithm of `@hachiman/client/permissions`, so Takusen and
 * the clients compute the same sets.
 */
import { computeChannelPermissions, has, Permissions } from '@hachiman/client/permissions'

import { hasTextGroup } from '@/lib/channel-types'

import { drizzleMlsRepo, type Executor } from './repo.drizzle'
import type { ChannelInfo, GroupRow, GuildPermissionData, MlsRepo, OverwriteInfo } from './repo'

export type { Executor } from './repo.drizzle'

export async function channelReaders(executor: Executor, channelId: string): Promise<Set<string>> {
  return channelReadersWith(drizzleMlsRepo(executor), channelId)
}

export async function isPublicChannel(executor: Executor, channelId: string): Promise<boolean> {
  return isPublicChannelWith(drizzleMlsRepo(executor), channelId)
}

export async function groupReaders(executor: Executor, groupId: Uint8Array): Promise<Set<string>> {
  return groupReadersWith(drizzleMlsRepo(executor), groupId)
}

// MARK: - Implementations over MlsRepo

export function readersFrom(data: GuildPermissionData, overwrites: OverwriteInfo[]): Set<string> {
  const out = new Set<string>()
  for (const [userId, roleIds] of data.members) {
    const p = computeChannelPermissions(data.guild, { user: { id: userId }, roles: roleIds }, data.roles, { permissionOverwrites: overwrites })
    if (has(p, Permissions.VIEW_CHANNEL)) out.add(userId)
  }
  return out
}

/** Guild text channel: members with VIEW_CHANNEL. DM: the participants. Other types: empty. */
export async function channelReadersWith(repo: MlsRepo, channelId: string): Promise<Set<string>> {
  const channel = await repo.getChannel(channelId)
  if (!channel) return new Set()
  return readersOfChannel(repo, channel)
}

export async function readersOfChannel(repo: MlsRepo, channel: ChannelInfo): Promise<Set<string>> {
  if (channel.type === 'dm' || channel.type === 'group_dm') return new Set(await repo.getDmParticipants(channel.id))
  if (!channel.guildId) return new Set()
  const data = await repo.getGuildPermissionData(channel.guildId)
  if (!data) return new Set()
  return readersFrom(data, await repo.getChannelOverwrites(channel.id))
}

/**
 * §12.6: a guild text channel is public when @everyone (with the channel
 * @everyone overwrite) has VIEW_CHANNEL, and no role or member overwrite on
 * the channel denies VIEW_CHANNEL.
 */
export function isPublicFrom(guildId: string, everyonePermissions: number, overwrites: OverwriteInfo[]): boolean {
  let p = everyonePermissions
  const everyone = overwrites.find((o) => o.type === 'role' && o.id === guildId)
  if (everyone) p = (p & ~everyone.deny) | everyone.allow
  if (!has(p, Permissions.VIEW_CHANNEL)) return false
  return !overwrites.some((o) => !(o.type === 'role' && o.id === guildId) && (o.deny & Permissions.VIEW_CHANNEL) !== 0)
}

export async function isPublicChannelWith(repo: MlsRepo, channelId: string): Promise<boolean> {
  const channel = await repo.getChannel(channelId)
  if (!channel || !hasTextGroup(channel.type) || !channel.guildId) return false
  const data = await repo.getGuildPermissionData(channel.guildId)
  if (!data) return false
  const everyone = data.roles.get(channel.guildId)?.permissions ?? 0
  return isPublicFrom(channel.guildId, everyone, await repo.getChannelOverwrites(channelId))
}

/** public_set: every guild member. channel: channelReaders. dm: the participants. */
export async function readersOfGroup(repo: MlsRepo, group: Pick<GroupRow, 'kind' | 'guildId' | 'channelId'>): Promise<Set<string>> {
  if (group.kind === 'public_set') {
    if (!group.guildId) return new Set()
    const data = await repo.getGuildPermissionData(group.guildId)
    return new Set(data?.members.keys() ?? [])
  }
  if (!group.channelId) return new Set()
  return channelReadersWith(repo, group.channelId)
}

export async function groupReadersWith(repo: MlsRepo, groupId: Uint8Array): Promise<Set<string>> {
  const group = await repo.getGroup(groupId)
  return group ? readersOfGroup(repo, group) : new Set()
}

/** The caller's permissions in a guild channel (null for DMs and unknown channels). */
export async function channelPermissionsOf(repo: MlsRepo, channelId: string, userId: string): Promise<number> {
  const channel = await repo.getChannel(channelId)
  if (!channel?.guildId) return 0
  const data = await repo.getGuildPermissionData(channel.guildId)
  const roles = data?.members.get(userId)
  if (!data || !roles) return 0
  return computeChannelPermissions(data.guild, { user: { id: userId }, roles }, data.roles, {
    permissionOverwrites: await repo.getChannelOverwrites(channelId),
  })
}
