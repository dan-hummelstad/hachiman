/**
 * AdminPermissionModel over the §2 rules of @hachiman/client/permissions (docs/gateway-protocol.md
 * §12.16). The replayed admin chain gives the guild, roles, member roles and overwrites. This file
 * maps them to the GuildLike / MemberLike / RoleMap shapes, so each language keeps one permission
 * implementation. Only src/worker/** imports @hachiman/client.
 */
import { computeBasePermissions, computeChannelPermissions, highestRolePosition } from '@hachiman/client/permissions'

import type { AdminPermissionModel, AdminReplayState, ChannelId, UserId } from '../api'

function rolesOf(s: AdminReplayState): Map<string, { id: string; permissions: number; position: number }> {
  return new Map(s.roles.map((r) => [r.id, { id: r.id, permissions: r.permissions, position: r.position }]))
}

function memberOf(s: AdminReplayState, userId: UserId): { roles: string[]; user: { id: string } } {
  return { roles: [...(s.memberRoles.find((m) => m.userId === userId)?.roleIds ?? [])], user: { id: userId } }
}

const guildOf = (s: AdminReplayState): { id: string; ownerId: string } => ({ id: s.guildId, ownerId: s.ownerId })

function overwritesOf(s: AdminReplayState, channelId: ChannelId): { id: string; type: 'role' | 'member'; allow: number; deny: number }[] {
  return s.overwrites.filter((o) => o.channelId === channelId).map((o) => ({ id: o.targetId, type: o.targetType, allow: o.allow, deny: o.deny }))
}

export const clientPermissions: AdminPermissionModel = {
  guildPermissions(state, userId) {
    return computeBasePermissions(guildOf(state), memberOf(state, userId), rolesOf(state))
  },

  channelPermissions(state, channelId, userId, guildMembers) {
    // A user outside the guild reads no channel of it, whatever the chain says.
    if (!guildMembers.includes(userId)) return 0
    return computeChannelPermissions(guildOf(state), memberOf(state, userId), rolesOf(state), { permissionOverwrites: overwritesOf(state, channelId) })
  },

  /** The owner outranks every role. Else the actor's highest role must be strictly above it. */
  outranks(state, actorUserId, roleId) {
    if (actorUserId === state.ownerId) return true
    const roles = rolesOf(state)
    const target = roles.get(roleId)
    if (target === undefined) return false
    return highestRolePosition(memberOf(state, actorUserId), roles) > target.position
  },
}
