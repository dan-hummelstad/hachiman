/**
 * Row → wire-shape converters (docs/gateway-protocol.md §1) and the pure
 * GuildFull assembly. No DB access here so it is unit-testable; the loaders
 * live in `guilds.ts`.
 */
import { z } from 'zod'
import { computeChannelPermissions, Permissions } from '@hachiman/client/permissions'
import type {
  Attachment,
  Channel,
  Guild,
  GuildFull,
  Invite,
  Member,
  Message,
  PermissionOverwrite,
  Presence,
  Role,
  User,
  VoiceState,
} from '@hachiman/client/types'

import type {
  ChannelRow,
  GuildMemberRow,
  GuildRow,
  InviteRow,
  MessageRow,
  PermissionOverwriteRow,
  RoleRow,
} from '@/db/schema'

/** The `users` columns every wire `User` is built from. */
export interface UserLike {
  id: string
  displayName: string
  name: string | null
  email: string
  image: string | null
}

export function toUser(u: UserLike): User {
  return {
    id: u.id,
    username: u.displayName || u.name || u.email.split('@')[0],
    avatar: u.image,
  }
}

export function toGuild(g: GuildRow): Guild {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    banner: g.banner,
    ownerId: g.ownerId,
    region: g.region,
    createdAt: g.createdAt.toISOString(),
  }
}

export function toRole(r: RoleRow): Role {
  return {
    id: r.id,
    guildId: r.guildId,
    name: r.name,
    color: r.color,
    position: r.position,
    permissions: r.permissions,
  }
}

export function toOverwrite(o: PermissionOverwriteRow): PermissionOverwrite {
  return { id: o.targetId, type: o.targetType, allow: o.allow, deny: o.deny }
}

/** Guild channel. DMs go through `toDmChannel`. */
export function toChannel(c: ChannelRow, overwrites: PermissionOverwriteRow[]): Channel {
  return {
    id: c.id,
    guildId: c.guildId,
    type: c.type,
    name: c.name,
    topic: c.topic,
    parentId: c.parentId,
    position: c.position,
    permissionOverwrites: overwrites.filter((o) => o.channelId === c.id).map(toOverwrite),
  }
}

/** DM / group DM as seen by one viewer: `recipients` excludes the viewer. */
export function toDmChannel(c: ChannelRow, participants: UserLike[], viewerId: string): Channel {
  const channel: Channel = {
    id: c.id,
    guildId: null,
    type: c.type,
    name: c.name,
    topic: c.topic,
    parentId: null,
    position: 0,
    permissionOverwrites: [],
    recipients: participants.filter((p) => p.id !== viewerId).map(toUser),
  }
  if (c.type === 'group_dm') channel.ownerId = c.ownerId
  return channel
}

export function toMember(m: GuildMemberRow, user: UserLike, roleIds: string[]): Member {
  return {
    guildId: m.guildId,
    user: toUser(user),
    nick: m.nick,
    roles: roleIds.filter((id) => id !== m.guildId),
    joinedAt: m.joinedAt.toISOString(),
  }
}

export function toMessage(
  m: MessageRow,
  author: UserLike,
  guildId: string | null,
  attachments: Attachment[],
  nonce?: string,
): Message {
  const msg: Message = {
    id: m.id,
    channelId: m.channelId,
    guildId,
    author: toUser(author),
    content: m.content,
    attachments,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
  }
  if (nonce !== undefined) msg.nonce = nonce
  return msg
}

export function toInvite(i: InviteRow): Invite {
  return {
    code: i.code,
    guildId: i.guildId,
    createdBy: i.createdBy,
    expiresAt: i.expiresAt ? i.expiresAt.toISOString() : null,
    maxUses: i.maxUses,
    uses: i.uses,
    createdAt: i.createdAt.toISOString(),
  }
}

export interface GuildFullInput {
  guild: GuildRow
  roles: RoleRow[]
  channels: ChannelRow[]
  overwrites: PermissionOverwriteRow[]
  members: { member: GuildMemberRow; user: UserLike }[]
  memberRoles: { userId: string; roleId: string }[]
  viewerId: string
  voiceStates: VoiceState[]
  presences: Presence[]
}

/** Build the viewer's GuildFull: channels are filtered to those it can VIEW. */
export function assembleGuildFull(input: GuildFullInput): GuildFull {
  const rolesByUser = new Map<string, string[]>()
  for (const mr of input.memberRoles) {
    const list = rolesByUser.get(mr.userId) ?? []
    list.push(mr.roleId)
    rolesByUser.set(mr.userId, list)
  }
  const members = input.members.map(({ member, user }) =>
    toMember(member, user, rolesByUser.get(member.userId) ?? []),
  )
  const roles = input.roles.map(toRole)
  const roleMap = new Map(roles.map((r) => [r.id, r]))
  const guild = toGuild(input.guild)
  const viewer = members.find((m) => m.user.id === input.viewerId)
  const channels = input.channels
    .map((c) => toChannel(c, input.overwrites))
    .filter(
      (c) =>
        viewer !== undefined &&
        (computeChannelPermissions(guild, viewer, roleMap, c) & Permissions.VIEW_CHANNEL) !== 0,
    )
  return {
    ...guild,
    channels,
    roles,
    members,
    voiceStates: input.voiceStates,
    presences: input.presences,
  }
}

// ---------------------------------------------------------------------------
// GET /channels/:id/messages query
// ---------------------------------------------------------------------------
export const MESSAGE_MAX_LENGTH = 2000
export const MESSAGE_PAGE_DEFAULT = 50
export const MESSAGE_PAGE_MAX = 100

const messageQuerySchema = z.object({
  before: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(MESSAGE_PAGE_MAX).default(MESSAGE_PAGE_DEFAULT),
})

export function parseMessageQuery(params: URLSearchParams): { before?: string; limit: number } {
  return messageQuerySchema.parse({
    before: params.get('before') ?? undefined,
    limit: params.get('limit') ?? undefined,
  })
}
