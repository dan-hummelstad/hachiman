/**
 * Row → wire-shape converters (docs/gateway-protocol.md §1), the pure
 * GuildFull assembly and the message body rules (§4, §12.8.4). No DB access
 * here so it is unit-testable; the loaders live in `guilds.ts`.
 */
import { z } from 'zod'
import { computeChannelPermissions, Permissions } from '@hachiman/client/permissions'
import type {
  Attachment,
  Channel,
  Guild,
  GuildFull,
  HistoryVisibility,
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
import type { AcceptedEnvelope } from '@/lib/mls/envelopes'
import { fromB64, toB64 } from '@/lib/mls/bytes'

import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_MESSAGE_UPLOAD_IDS } from '@hachiman/crypto/constants'

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

/** The public_set default (§12.6), used until the guild's group row says otherwise. */
export const DEFAULT_PUBLIC_HISTORY_VISIBILITY: HistoryVisibility = 'shared'

/** `publicHistoryVisibility` mirrors the guild's current public_set group (§12.6). */
export function toGuild(g: GuildRow, publicHistoryVisibility: HistoryVisibility): Guild {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    banner: g.banner,
    ownerId: g.ownerId,
    region: g.region,
    createdAt: g.createdAt.toISOString(),
    publicHistoryVisibility,
  }
}

/** The MLS group fields of a channel: base64url group id → its history visibility. */
export type GroupVisibility = ReadonlyMap<string, HistoryVisibility>

const NO_GROUPS: GroupVisibility = new Map()

/**
 * text, dm and group_dm channels have a group (§12.6). Before the DS has
 * allocated one, the value is the default of a channel or dm group.
 */
function groupFields(c: ChannelRow, groups: GroupVisibility): Pick<Channel, 'mlsGroupId' | 'historyVisibility'> {
  if (c.type === 'voice' || c.type === 'category') return { mlsGroupId: null, historyVisibility: null }
  const mlsGroupId = c.mlsGroupId ? toB64(c.mlsGroupId) : null
  return { mlsGroupId, historyVisibility: (mlsGroupId && groups.get(mlsGroupId)) || 'joined' }
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
export function toChannel(c: ChannelRow, overwrites: PermissionOverwriteRow[], groups: GroupVisibility = NO_GROUPS): Channel {
  return {
    id: c.id,
    guildId: c.guildId,
    type: c.type,
    name: c.name,
    topic: c.topic,
    parentId: c.parentId,
    position: c.position,
    permissionOverwrites: overwrites.filter((o) => o.channelId === c.id).map(toOverwrite),
    ...groupFields(c, groups),
  }
}

/** DM / group DM as seen by one viewer: `recipients` excludes the viewer. */
export function toDmChannel(c: ChannelRow, participants: UserLike[], viewerId: string, groups: GroupVisibility = NO_GROUPS): Channel {
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
    ...groupFields(c, groups),
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

/** The ciphertext Message (§1). The server never sees the content. */
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
    senderDevice: m.senderDevice,
    groupId: toB64(m.groupId),
    epoch: m.epoch,
    clientMsgId: toB64(m.clientMsgId),
    envelope: toB64(m.envelope),
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
  /** The history visibility of the guild's groups, by base64url group id. */
  groups?: GroupVisibility
  publicHistoryVisibility?: HistoryVisibility
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
  const guild = toGuild(input.guild, input.publicHistoryVisibility ?? DEFAULT_PUBLIC_HISTORY_VISIBILITY)
  const viewer = members.find((m) => m.user.id === input.viewerId)
  const channels = input.channels
    .map((c) => toChannel(c, input.overwrites, input.groups))
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

// ---------------------------------------------------------------------------
// POST / PATCH /channels/:id/messages bodies (§4, §12.8.4)
// ---------------------------------------------------------------------------

/**
 * For each attachment pointer: the file id, then the thumbnail id when it has
 * one. At most 20 ids (10 files with a thumbnail each).
 */
export const MESSAGE_MAX_UPLOAD_IDS = MAX_MESSAGE_UPLOAD_IDS
export const MESSAGE_MAX_FILES = MAX_ATTACHMENTS_PER_MESSAGE

/**
 * The envelope as base64url. The text cap only bounds the JSON body: the byte
 * limit (TAKUSEN_MAX_ENVELOPE_BYTES, 413 EnvelopeTooLarge) is in acceptEnvelope.
 */
const envelopeField = z
  .string()
  .min(1)
  .max(4 * 1024 * 1024)
  .transform((s, ctx) => {
    const bytes = fromB64(s)
    if (!bytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'envelope is not base64url' })
      return z.NEVER
    }
    return bytes
  })

export const createMessageSchema = z.object({
  envelope: envelopeField,
  nonce: z.union([z.string().max(64), z.number().int()]).transform(String).optional(),
  attachments: z
    .array(z.string().uuid())
    .max(MESSAGE_MAX_UPLOAD_IDS)
    .refine((ids) => new Set(ids).size === ids.length, 'Duplicate upload id')
    .default([]),
})
export type CreateMessageBody = z.infer<typeof createMessageSchema>

/** An edit replaces only the envelope. The attachments stay (§12.8.6). */
export const editMessageSchema = z.object({ envelope: envelopeField }).strict()

/** The columns that a new message stores (§12.8.4 "On send"). */
export function messageInsertValues(input: { channelId: string; authorId: string; envelope: Uint8Array; accepted: AcceptedEnvelope }) {
  const { accepted } = input
  return {
    channelId: input.channelId,
    authorId: input.authorId,
    groupId: accepted.groupId,
    epoch: accepted.epoch,
    senderDevice: accepted.senderDeviceId,
    clientMsgId: accepted.clientMsgId,
    envelope: input.envelope,
    frankingTag: accepted.frankingTag,
    size: accepted.size,
  }
}

/**
 * The columns that an edit replaces (§12.8.4 "On edit"). `client_msg_id`,
 * `author_id` and the attachment rows stay.
 */
export function messageEditPatch(envelope: Uint8Array, accepted: AcceptedEnvelope, now: Date) {
  return {
    envelope,
    groupId: accepted.groupId,
    epoch: accepted.epoch,
    senderDevice: accepted.senderDeviceId,
    frankingTag: accepted.frankingTag,
    size: accepted.size,
    editedAt: now,
  }
}
