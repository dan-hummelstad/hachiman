// Wire types. Contract: docs/gateway-protocol.md §1 and §6.

export type ChannelType = 'text' | 'voice' | 'category' | 'dm' | 'group_dm'
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

// avatar, icon and banner are file keys (§4 Files), not URLs: build the URL with RestClient.fileUrl.
export interface User {
  id: string
  username: string
  avatar: string | null
}

export interface Guild {
  id: string
  name: string
  icon: string | null
  banner: string | null
  ownerId: string
  region: string | null
  createdAt: string
}

/** One uploaded file. width/height come from the uploader (images and video only) and are for layout only. */
export interface Attachment {
  id: string
  key: string
  filename: string
  size: number
  contentType: string
  width: number | null
  height: number | null
}

export interface Limits {
  maxUploadBytes: number
  maxAttachmentsPerMessage: number
}

/** The @everyone role has `id === guildId` and position 0. */
export interface Role {
  id: string
  guildId: string
  name: string
  color: number
  position: number
  permissions: number
}

export interface PermissionOverwrite {
  id: string
  type: 'role' | 'member'
  allow: number
  deny: number
}

export interface Channel {
  id: string
  guildId: string | null
  type: ChannelType
  name: string | null
  topic: string | null
  parentId: string | null
  position: number
  permissionOverwrites: PermissionOverwrite[]
  recipients?: User[]
  ownerId?: string | null
}

export interface Member {
  guildId: string
  user: User
  nick: string | null
  /** Role ids, excluding @everyone. */
  roles: string[]
  joinedAt: string
}

export interface Message {
  id: string
  channelId: string
  guildId: string | null
  author: User
  /** '' is allowed when attachments is not empty. */
  content: string
  /** Upload order. */
  attachments: Attachment[]
  createdAt: string
  editedAt: string | null
  nonce?: string
}

export interface Invite {
  code: string
  guildId: string
  createdBy: string
  expiresAt: string | null
  maxUses: number | null
  uses: number
  createdAt: string
}

export interface InvitePreview {
  code: string
  guild: Pick<Guild, 'id' | 'name' | 'icon'>
  memberCount: number
  expiresAt: string | null
}

export interface Presence {
  userId: string
  status: PresenceStatus
}

export interface VoiceState {
  guildId: string
  channelId: string | null
  userId: string
  sessionId: string
  selfMute: boolean
  selfDeaf: boolean
  selfStream: boolean
}

export interface GuildFull extends Guild {
  channels: Channel[]
  roles: Role[]
  members: Member[]
  voiceStates: VoiceState[]
  presences: Presence[]
}

// ---- Gateway (§6) ----

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const
export type GatewayOp = (typeof GatewayOp)[keyof typeof GatewayOp]

export interface GatewayFrame {
  op: GatewayOp
  d: unknown
  s?: number
  t?: string
}

export interface ReadyPayload {
  v: 1
  sessionId: string
  user: User
  guilds: GuildFull[]
  privateChannels: Channel[]
  presences: Presence[]
}

export interface VoiceServerUpdate {
  guildId: string
  channelId: string
  endpoint: string
  token: string
  iceServers: RTCIceServer[]
  expiresAt: string
}

export interface VoiceStateUpdateRequest {
  guildId: string
  channelId: string | null
  selfMute: boolean
  selfDeaf: boolean
  selfStream: boolean
}

/** Dispatch event name → payload. */
export interface GatewayEvents {
  READY: ReadyPayload
  RESUMED: Record<string, never>
  GUILD_CREATE: GuildFull
  GUILD_UPDATE: Guild
  GUILD_DELETE: { id: string }
  CHANNEL_CREATE: Channel
  CHANNEL_UPDATE: Channel
  CHANNEL_DELETE: Channel
  MESSAGE_CREATE: Message
  MESSAGE_UPDATE: Message
  MESSAGE_DELETE: { id: string; channelId: string; guildId: string | null }
  TYPING_START: { channelId: string; guildId: string | null; userId: string; timestamp: string }
  GUILD_MEMBER_ADD: Member
  GUILD_MEMBER_UPDATE: Member
  GUILD_MEMBER_REMOVE: { guildId: string; user: User }
  /** The current user changed. Other users see it through GUILD_MEMBER_UPDATE. */
  USER_UPDATE: User
  GUILD_ROLE_CREATE: { guildId: string; role: Role }
  GUILD_ROLE_UPDATE: { guildId: string; role: Role }
  GUILD_ROLE_DELETE: { guildId: string; roleId: string }
  PRESENCE_UPDATE: Presence
  VOICE_STATE_UPDATE: VoiceState
  VOICE_SERVER_UPDATE: VoiceServerUpdate
}
export type GatewayEventName = keyof GatewayEvents

/** Redis pub/sub envelope Oracle publishes on `guild:{id}` / `user:{id}` (§5). */
export interface BusEnvelope<T extends GatewayEventName = GatewayEventName> {
  t: T
  d: GatewayEvents[T]
  channelId?: string
}

// ---- Media voice WS (§8) ----

export type VoiceClientFrame =
  | { op: 'identify'; d: { token: string } }
  | { op: 'answer'; d: { sdp: string } }
  | { op: 'candidate'; d: { candidate: RTCIceCandidateInit | null } }
  | { op: 'speaking'; d: { speaking: boolean } }

export type VoiceServerFrame =
  | { op: 'ready'; d: { sessionId: string; ssrc: number } }
  | { op: 'offer'; d: { sdp: string } }
  | { op: 'candidate'; d: { candidate: RTCIceCandidateInit | null } }
  | { op: 'peers'; d: { peers: { userId: string; ssrc: number }[] } }
  | { op: 'speaking'; d: { userId: string; speaking: boolean } }
