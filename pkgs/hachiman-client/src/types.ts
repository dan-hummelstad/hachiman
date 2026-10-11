// Wire types. Contract: docs/gateway-protocol.md §1, §6, §8, §12.12 and §12.13.
// The E2EE shapes mirror the Wire* and voice op types of @hachiman/crypto (src/api.ts)
// structurally. This file imports nothing: permissions.ts and @hachiman/crypto depend on it.

export type ChannelType = 'text' | 'voice' | 'category' | 'dm' | 'group_dm' | 'pages' | 'thread'
export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

/** base64url without padding (§12.2). */
export type B64url = string
export type HistoryVisibility = 'joined' | 'shared'
/** RFC 9420 cipher suites that Hachiman accepts (§12.3): 1 = X25519/AES-128-GCM, 83 = X-Wing. */
export type CipherSuiteId = 1 | 83

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
  /** History visibility of the guild's public_set group (§12.6). */
  publicHistoryVisibility: HistoryVisibility
  /** The text channel that shows a line when a member joins, or null (§4 Guilds). */
  welcomeChannelId: string | null
}

/**
 * One encrypted blob (§12.9). The file name, MIME type, dimensions and plaintext size are only
 * in the envelope. `key` is `${id}/blob`, `size` is the blob size in bytes.
 */
export interface Attachment {
  id: string
  key: string
  size: number
}

export interface Limits {
  maxUploadBytes: number
  maxAttachmentsPerMessage: number
  maxEnvelopeBytes: number
  /** TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES: the blob cap of `POST /uploads?kind=page_snapshot` (§4 Pages). */
  maxPageSnapshotBytes: number
}

/** The @everyone role has `id === guildId` and position 0. */
export interface Role {
  id: string
  guildId: string
  name: string
  color: number
  /** Shown as its own group in the member list. Changes no permission. */
  hoist: boolean
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
  /** text, pages, dm, group_dm: the current MLS group (§12.6). thread: the group of its parent. null: no group yet, or voice/category. */
  mlsGroupId: B64url | null
  /** text, pages, dm, group_dm, thread: the effective value. null for voice/category. */
  historyVisibility: HistoryVisibility | null
  /** thread: the message in the parent channel that starts the thread, or null. Absent on other types. */
  threadStartMessageId?: string | null
}

export interface Member {
  guildId: string
  user: User
  nick: string | null
  /** Role ids, excluding @everyone. */
  roles: string[]
  joinedAt: string
  /** Server mute (MUTE_MEMBERS). Stays across calls. */
  mute: boolean
  /** Server deafen (DEAFEN_MEMBERS). Stays across calls. */
  deaf: boolean
}

/** A guild ban (§4 Bans). The user cannot join the guild through an invite while it exists. */
export interface Ban {
  user: User
  reason: string | null
  createdAt: string
}

/** Ciphertext only. The client decrypts `envelope` (§12.8). */
export interface Message {
  id: string
  channelId: string
  guildId: string | null
  author: User
  /** null after the device row is gone. */
  senderDevice: string | null
  groupId: B64url
  epoch: number
  /** 16 bytes. An edit keeps the id of the original. */
  clientMsgId: B64url
  /** The Envelope (§12.8.1). An edit replaces it. */
  envelope: B64url
  /** Position order: for each pointer, the file and then its thumbnail. */
  attachments: Attachment[]
  createdAt: string
  editedAt: string | null
  nonce?: string
}

export interface Invite {
  /** `sendInviteBundles` and `POST /invite-records/:inviteId/bundles` name the invite by it (§12.12). */
  id: string
  code: string
  guildId: string
  createdBy: string
  expiresAt: string | null
  maxUses: number | null
  uses: number
  createdAt: string
  /** The invite has a signed record: the link carries history (§12.11.4). */
  hasHistory: boolean
}

export interface InvitePreview {
  code: string
  guild: Pick<Guild, 'id' | 'name' | 'icon'>
  memberCount: number
  expiresAt: string | null
  hasHistory: boolean
}

/** A user-chosen status line (§1). Plaintext, shown to the people who see the presence. */
export interface CustomStatus {
  /** 1 to 64 characters, trimmed, no control characters. */
  text: string
  /** RFC 3339. Hide the status from this time on: the gateway sends no event at expiry. */
  expiresAt: string | null
}

/**
 * A scheduled guild event (§4 "Guild events"). Plaintext metadata, like a channel topic.
 * `channelId` is an optional voice channel of the guild. `rsvpCount` counts the "going" members.
 */
export interface GuildEvent {
  id: string
  guildId: string
  channelId: string | null
  title: string
  startsAt: string
  endsAt: string | null
  createdBy: string | null
  createdAt: string
  rsvpCount: number
}

/**
 * A custom guild emoji (§4 Emojis). Plaintext, like the guild icon. `key` is the file key of the
 * image (RestClient.fileUrl). A message names it as `<:name:id>` inside its envelope.
 */
export interface GuildEmoji {
  id: string
  guildId: string
  /** 2–32 characters of [a-z0-9_], unique in the guild. */
  name: string
  key: string
  createdBy: string | null
  createdAt: string
}

export interface CreateGuildEmojiRequest {
  name: string
  /** A plaintext upload from {@link RestClient.uploadImage}: PNG, GIF or WebP, at most 256 KiB. */
  uploadId: string
}

/** `GET /guilds/:id/events` adds `me`: true when the caller is going. */
export interface GuildEventWithMe extends GuildEvent {
  me: boolean
}

export interface CreateGuildEventRequest {
  title: string
  startsAt: string
  endsAt?: string | null
  channelId?: string | null
}

export type UpdateGuildEventRequest = Partial<CreateGuildEventRequest>

/**
 * A soundboard sound (§4 Soundboard). `name` and `emoji` are plaintext metadata. The clip is the
 * encrypted blob `key`. `envelope` is the sound pointer with its file key (§12.21): the client
 * decrypts it with `decryptDoc` (kind doc_snapshot, page id = the sound id, channel `channelId`).
 */
export interface GuildSound {
  id: string
  guildId: string
  name: string
  emoji: string | null
  uploadId: string
  /** `${uploadId}/blob`. */
  key: string
  /** Blob bytes. */
  size: number
  channelId: string
  groupId: string
  epoch: number
  senderDevice: string | null
  envelope: string
  createdBy: string | null
  createdAt: string
}

export interface CreateGuildSoundRequest {
  /** Chosen by the client: the envelope binds it. */
  id: string
  name: string
  emoji?: string | null
  /** A blob from POST /uploads?kind=blob, at most SOUND_MAX_BLOB_BYTES. */
  uploadId: string
  /** A public text or pages channel of the guild: its group (the public_set group) seals the envelope. */
  channelId: string
  envelope: string
}

/** One entry of `GET /users/@me/blocks`. */
export interface BlockedUser {
  user: User
  createdAt: string
}

export interface Presence {
  userId: string
  status: PresenceStatus
  /** Absent: no custom status. */
  customStatus?: CustomStatus
}

export interface VoiceState {
  /** null: a DM or group DM call (§6 "DM calls"). */
  guildId: string | null
  channelId: string | null
  userId: string
  sessionId: string
  selfMute: boolean
  selfDeaf: boolean
  /** Server mute and deafen: the `mute` / `deaf` of the Member. Absent from an older gateway. */
  mute?: boolean
  deaf?: boolean
  selfStream: boolean
  /** RFC 3339: when this session joined the channel. Kept across mute, deafen and stream changes, reset on a move. Absent from an older gateway. */
  joinedAt?: string
}

// ---- Pages (§1, §4 Pages, §12.20) ----

/** One page of a pages channel. The server sees only the tree and the timestamps. */
export interface Page {
  /** Chosen by the client on create (the title envelope binds it). */
  id: string
  channelId: string
  /** null for a root page. A page in the same channel. */
  parentId: string | null
  position: number
  /** The doc_title envelope (§12.20). */
  titleEnvelope: B64url
  /** null after the user is gone. */
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

/** One encrypted Yjs update (a doc_update envelope, §12.20). `seq` is per page, from 1, without gaps. */
export interface DocUpdate {
  pageId: string
  seq: number
  groupId: B64url
  epoch: number
  senderDevice: string | null
  envelope: B64url
  createdAt: string
}

/**
 * A snapshot: the full Yjs state up to and including `baseSeq`. The state is an encrypted blob
 * (`key`, §12.9). `envelope` is the doc_snapshot envelope with its pointer (§12.20).
 */
export interface DocSnapshot {
  pageId: string
  baseSeq: number
  uploadId: string
  /** `${uploadId}/blob`, for RestClient.fileUrl / fetchBlob. */
  key: string
  /** Blob bytes. */
  size: number
  groupId: B64url
  epoch: number
  senderDevice: string | null
  envelope: B64url
  /** The page_media uploads that the state references. */
  mediaUploadIds: string[]
  createdAt: string
}

/** GET /pages/:pageId/state. `updates` follow `snapshot.baseSeq` (or 0), at most 500: page the rest. */
export interface PageState {
  snapshot: DocSnapshot | null
  updates: DocUpdate[]
  latestSeq: number
}

/** One page of GET /channels/:id/pages/heads: what a re-wrap pass needs (§12.20 "Access by new members"). */
export interface PageHead {
  pageId: string
  latestSeq: number
  /** The group and epoch of the title envelope header. null when the header does not decode. */
  title: { groupId: B64url; epoch: number } | null
  /** The newest snapshot. */
  snapshot: DocSnapshot | null
}

export interface DocUpdatePage {
  updates: DocUpdate[]
  latestSeq: number
}

/** Op 5 DOC_AWARENESS, client → gateway (§6). `envelope` is a doc_awareness envelope, at most 8 KiB as base64url. */
export interface DocAwarenessRequest {
  channelId: string
  pageId: string
  envelope: B64url
}

export interface GuildFull extends Guild {
  channels: Channel[]
  roles: Role[]
  members: Member[]
  voiceStates: VoiceState[]
  presences: Presence[]
  /** The custom emojis of the guild, oldest first. */
  emojis: GuildEmoji[]
}

// ---- E2EE REST shapes (§12.12) ----

export type DeviceStatus = 'pending' | 'active' | 'revoked'
export type DevicePlatform = 'electron' | 'browser' | 'ios'
export type RevocationReason = 'user' | 'lost' | 'password_reset' | 'compromised' | 'signed_out'
export type MlsGroupKind = 'public_set' | 'channel' | 'dm'
export type MlsGroupStatus = 'pending' | 'active' | 'retired'
export type HandshakeKind = 'commit' | 'external_commit' | 'proposal'
export type JoinRequestStatus = 'queued' | 'committed' | 'rejected' | 'external_commit' | 'waiting'
export type InboxKind = 'welcome' | 'dsk_transfer' | 'history_keys'
export type BatchRejectReason = 'invalid_chain' | 'not_reader' | 'revoked' | 'policy' | 'malformed'

export interface Device {
  id: string
  userId: string
  status: DeviceStatus
  /** The REST name. Other users see the certificate display name (§12.5). */
  name: string
  platform: DevicePlatform
  clientVersion: string
  certificate: B64url | null
  revocation: B64url | null
  revokeReason: RevocationReason | null
  createdAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

/** Each `ktIndex` has the encoded KtEntry beside it (§12.14). */
export interface UserKeys {
  userId: string
  masterKey: { generation: number; record: B64url; ktIndex: number | null; ktEntry: B64url | null } | null
  deviceSigningKey: {
    generation: number
    cert: B64url
    ktIndex: number | null
    ktEntry: B64url | null
  } | null
  devices: {
    id: string
    status: DeviceStatus
    certificate: B64url | null
    revocation: B64url | null
    ktIndex: number | null
    ktEntry: B64url | null
    revocationKtIndex: number | null
    revocationKtEntry: B64url | null
  }[]
}

export interface DsInfo {
  externalSender: B64url
  cipherSuites: CipherSuiteId[]
  ktPublicKey: B64url
  /** True when the DS signs KT tree heads. The crypto Worker pins it and then fails closed (§12.14). */
  ktRequired: boolean
  limits: {
    maxEnvelopeBytes: number
    maxInboxItemBytes: number
    maxHistoryBundleBytes: number
    maxBackupBlobBytes: number
    keyPackageTarget: number
    keyPackageLowWater: number
  }
}

export interface MlsGroup {
  groupId: B64url
  kind: MlsGroupKind
  guildId: string | null
  /** The channel for kind 'channel' | 'dm'. null for 'public_set'. */
  channelId: string | null
  generation: number
  cipherSuite: CipherSuiteId
  status: MlsGroupStatus
  epoch: number | null
  historyVisibility: HistoryVisibility
  latestSeq: number
  /** True when the caller's device has a leaf. */
  member: boolean
}

export interface GroupState {
  groupId: B64url
  epoch: number
  groupInfo: B64url
  ratchetTree: B64url
}

export interface CreateGroupRequest {
  groupId: B64url
  kind: MlsGroupKind
  guildId: string | null
  channelId: string | null
  cipherSuite: CipherSuiteId
  groupInfo: B64url
  ratchetTree: B64url
  assignmentId: string | null
}

export interface CommitRequest {
  /** The epoch that the commit applies to. */
  epoch: number
  commit: B64url
  /** GroupInfo of epoch + 1. */
  groupInfo: B64url
  ratchetTree: B64url
  welcome: B64url | null
  batchId: string | null
  /**
   * What the committer of an MLS_BATCH_ASSIGN leaves out: a join by `pendingId`, or a DS
   * proposal by `proposalRef` (base64url RFC 9420 ProposalRef). RestClient.postCommit sends
   * the `proposalRef` entries as `rejectedProposals` on the wire (§12.12).
   */
  rejected: BatchRejection[]
  /** DS Add proposals that the committer refused. Merged with the `proposalRef` entries of `rejected`. */
  rejectedProposals?: ProposalRejection[]
}

export interface ProposalRejection {
  proposalRef: B64url
  reason: BatchRejectReason
}

export type BatchRejection = { pendingId: string; reason: BatchRejectReason } | ProposalRejection

/** POST /mls/groups/:groupId/commits. 409 EpochConflict resolves as a value, not as an error. */
export type CommitResult =
  | { ok: true; epoch: number; seq: number }
  | { ok: false; code: 'EpochConflict'; epoch: number }

export interface Handshake {
  seq: number
  /** The epoch in which the message is valid (before the commit). */
  epoch: number
  kind: HandshakeKind
  senderDevice: string | null
  message: B64url
  /** Commits only: from the GroupInfo of epoch + 1 (§12.8.7). */
  next: { treeHash: B64url; confirmedTranscriptHash: B64url } | null
  createdAt: string
}

export interface HandshakePage {
  handshakes: Handshake[]
  latestSeq: number
}

export interface JoinRequest {
  id: string
  groupId: B64url
  deviceId: string
  status: JoinRequestStatus
  reason: string | null
  createdAt: string
}

export interface InboxItem {
  id: string
  seq: number
  kind: InboxKind
  senderDevice: string | null
  body: B64url
  createdAt: string
}

export interface BackupIndex {
  keyId: B64url | null
  items: {
    id: string
    kind: 'identity' | 'history'
    groupId: B64url | null
    epochFrom: number | null
    epochTo: number | null
    size: number
    createdAt: string
  }[]
}

export interface HistoryBundle {
  id: string
  groupId: B64url
  epoch: number
  senderDevice: string
  blob: B64url
  createdAt: string
}

export interface LinkSession {
  id: string
  newDeviceId: string
  offer: B64url
  createdAt: string
  expiresAt: string
}

export interface LinkMessage {
  seq: number
  fromDevice: string
  body: B64url
  createdAt: string
}

export interface KtTreeHead {
  treeSize: number
  timestamp: string
  rootHash: B64url
  /** The encoded SignedTreeHead (§12.14). */
  signed: B64url
}

export interface KtInclusionProof {
  leafIndex: number
  treeSize: number
  auditPath: B64url[]
}

export interface KtConsistencyProof {
  from: number
  to: number
  proof: B64url[]
}

export interface KtEntry {
  index: number
  userId: string
  /** 1 master key, 2 DSK cert, 3 device certificate, 4 device revocation. */
  type: 1 | 2 | 3 | 4
  entry: B64url
  createdAt: string
}

export interface AdminAction {
  guildId: string
  seq: number
  action: B64url
  createdAt: string
}

/** An active invite with history of a guild (GET /guilds/:id/invite-records, §12.11.4). */
export interface InviteRecord {
  inviteId: string
  /** sign_public of the record: the invite key id. */
  keyId: B64url
  /** The encoded SignedInviteRecord. */
  record: B64url
  expiresAt: string | null
  /** The newest stored bundle epoch of each group. */
  bundled: { groupId: B64url; epoch: number }[]
}

/** The bundles of an invite for its redeemer (GET /invites/:code/bundles, §12.11.4). */
export interface InviteBundles {
  inviteId: string
  /** The encoded SignedInviteRecord. */
  record: B64url
  /** `blob`: an encoded InviteBundle. */
  bundles: { groupId: B64url; epoch: number; blob: B64url; senderDevice: string }[]
}

// ---- Gateway (§6) ----

export const GatewayOp = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  DOC_AWARENESS: 5,
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

/** The device facts that IDENTIFY and RESUME send (§12.13). */
export interface GatewayDevice {
  deviceId: string
  capabilities: string[]
  clientVersion: string
}

/**
 * What the device signs (§12.12 "Device proof"): a DS request, or an IDENTIFY/RESUME. The prover
 * (the crypto Worker) adds the device id, ts and nonce and signs with the device MLS key.
 */
export type DeviceProofRequest =
  | { kind: 'ds'; method: string; pathAndQuery: string; bodySha256: Uint8Array }
  | { kind: 'identify'; sessionId: string | null; tokenSha256: Uint8Array }

/** X-Hachiman-Device-Ts / -Nonce / -Sig, and `deviceProof` of IDENTIFY and RESUME. */
export interface DeviceProof {
  /** Unix milliseconds. */
  ts: number
  nonce: string
  /** Ed25519, base64url. */
  sig: string
}

export type DeviceProver = (req: DeviceProofRequest) => Promise<DeviceProof>

export interface ReadyPayload {
  v: 1
  sessionId: string
  deviceId: string
  user: User
  guilds: GuildFull[]
  privateChannels: Channel[]
  /** The live states of the DM calls (guildId null). Absent from an older gateway. */
  privateVoiceStates?: VoiceState[]
  presences: Presence[]
  /** One per viewable text, pages, dm and group_dm channel (§1 ReadState). */
  readStates: ReadState[]
}

/**
 * Where the current user has read to in one channel (§1). Messages are in
 * (createdAt, id) order. `lastReadMessageId` is null when the user never
 * acked the channel. Then `unreadCount` is 0 and `lastMessageId` tells if the
 * channel has messages.
 */
export interface ReadState {
  channelId: string
  lastReadMessageId: string | null
  /** Messages after `lastReadMessageId` from other authors, at most READ_STATE_UNREAD_CAP. READY only. */
  unreadCount: number
  /** The newest message of the channel, null when it has none. READY only. */
  lastMessageId: string | null
  /** The createdAt of `lastMessageId`, null with it. The DM order (most recent first). READY only. */
  lastMessageAt: string | null
}

/** The highest `unreadCount` in READY. */
export const READ_STATE_UNREAD_CAP = 100

export interface VoiceServerUpdate {
  guildId: string | null
  channelId: string
  endpoint: string
  token: string
  iceServers: RTCIceServer[]
  expiresAt: string
  /** true: a member with MOVE_MEMBERS moved this session to `channelId` (§6 "Voice moderation"). The client follows without an op 4. */
  moved?: boolean
}

/** CALL_RING (§6 "DM calls"). */
export interface CallRing {
  channelId: string
  /** The caller. */
  userId: string
  ringing: string[]
  /** RFC 3339: when the call started ringing. */
  at: string
}

/** Op 3 (§6). `status` absent: unchanged. `customStatus` absent: unchanged; null: clear. */
export interface PresenceUpdateRequest {
  status?: PresenceStatus
  customStatus?: { text: string; expiresAt?: string | null } | null
}

export interface VoiceStateUpdateRequest {
  /** null: a DM call. */
  guildId: string | null
  channelId: string | null
  selfMute: boolean
  selfDeaf: boolean
  selfStream: boolean
}

// ---- E2EE gateway payloads (§12.13) ----

export interface MlsHandshakeEvent {
  groupId: B64url
  seq: number
  epoch: number
  kind: HandshakeKind
  senderDevice: string | null
  /** null above 32 KiB: fetch it with RestClient.getHandshakes. */
  message: B64url | null
  next: Handshake['next']
}

export interface BatchAssign {
  batchId: string
  groupId: B64url
  epoch: number
  /** DS proposals that are already in the handshake stream (§12.7.4). */
  proposals: B64url[]
  /** Adds by value ('channel' and 'dm' groups only). */
  joins: { pendingId: string; userId: string; deviceId: string; keyPackage: B64url }[]
  create: {
    groupId: B64url
    kind: MlsGroupKind
    guildId: string | null
    channelId: string | null
    cipherSuite: CipherSuiteId
    historyVisibility: HistoryVisibility
  } | null
  historyBundleEpochs: number[]
  deadline: string
}

export interface UserKeysUpdate {
  userId: string
  kind: 'device_added' | 'device_revoked' | 'master_key_changed' | 'dsk_rotated'
  deviceId: string | null
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
  /** To `user:{id}`: a session of the current user acked a channel (POST /channels/:id/ack). */
  READ_STATE_UPDATE: { channelId: string; lastReadMessageId: string }
  GUILD_MEMBER_ADD: Member
  GUILD_MEMBER_UPDATE: Member
  GUILD_MEMBER_REMOVE: { guildId: string; user: User }
  /** The current user changed. Other users see it through GUILD_MEMBER_UPDATE. */
  USER_UPDATE: User
  GUILD_ROLE_CREATE: { guildId: string; role: Role }
  GUILD_ROLE_UPDATE: { guildId: string; role: Role }
  GUILD_ROLE_DELETE: { guildId: string; roleId: string }
  /** An invite was revoked: by DELETE /invites/:code, or because its creator lost ADMINISTRATOR. To every member. */
  INVITE_DELETE: { guildId: string; code: string; inviteId: string }
  PRESENCE_UPDATE: Presence
  VOICE_STATE_UPDATE: VoiceState
  VOICE_SERVER_UPDATE: VoiceServerUpdate
  /** A DM call started (§6 "DM calls"): `userId` calls, `ringing` lists the users it rings. Stop ringing locally (30 s after `at` at the latest). */
  CALL_RING: CallRing
  MLS_HANDSHAKE: MlsHandshakeEvent
  MLS_GROUP_UPDATE: MlsGroup
  MLS_BATCH_ASSIGN: BatchAssign
  MLS_JOIN_UPDATE: { requestId: string; groupId: B64url; status: JoinRequestStatus; reason: string | null }
  DEVICE_INBOX: { id: string; seq: number; kind: InboxKind }
  DEVICE_LINK: { sessionId: string; seq: number; fromDevice: string }
  USER_KEYS_UPDATE: UserKeysUpdate
  KEY_PACKAGES_LOW: { deviceId: string; cipherSuite: CipherSuiteId; remaining: number }
  KT_TREE_HEAD: KtTreeHead
  PAGE_CREATE: Page & { guildId: string }
  PAGE_UPDATE: Page & { guildId: string }
  /** `ids`: the page and its whole subtree. */
  PAGE_DELETE: { id: string; channelId: string; guildId: string; ids: string[] }
  /** Ephemeral (no `s`, not in the resume buffer). Find a gap by `seq`, then GET /pages/:pageId/updates. */
  DOC_UPDATE: DocUpdate & { channelId: string; guildId: string }
  /** Ephemeral. `userId` and `deviceId` are the sending session's. Every viewing session gets it, the sender's included. */
  DOC_AWARENESS: DocAwarenessRequest & { guildId: string; userId: string; deviceId: string }
  /** The pin set of a channel changed. To the viewers of the channel (DM: the participants). Refetch GET /channels/:id/pins. */
  CHANNEL_PINS_UPDATE: { channelId: string; guildId: string | null }
  /** The full emoji list of the guild after a create, rename or delete. */
  GUILD_EMOJIS_UPDATE: { guildId: string; emojis: GuildEmoji[] }
  GUILD_EVENT_CREATE: GuildEvent
  GUILD_EVENT_UPDATE: GuildEvent
  GUILD_EVENT_DELETE: { id: string; guildId: string }
  GUILD_EVENT_RSVP: { eventId: string; guildId: string; userId: string; going: boolean; rsvpCount: number }
  /** The current user blocked or unblocked `userId`. To the user's own sessions only. */
  USER_BLOCK_UPDATE: { userId: string; blocked: boolean }
  /** A sound was added to or deleted from the soundboard. To every member. Refetch GET /guilds/:id/sounds. */
  GUILD_SOUNDS_UPDATE: { guildId: string }
  /** `user` poked the current user (POST /users/:id/poke). To the target's sessions only. No content. */
  POKE: { user: User }
}
export type GatewayEventName = keyof GatewayEvents

/** Redis pub/sub envelope Takusen publishes on `guild:{id}` / `user:{id}` / `device:{id}` (§5). */
export interface BusEnvelope<T extends GatewayEventName = GatewayEventName> {
  t: T
  d: GatewayEvents[T]
  channelId?: string
}

// ---- Media voice WS (§8) ----

export interface VoiceRosterEntry {
  sessionId: string
  userId: string
  deviceId: string
  leafIndex: number | null
}

/** Media → client e2ee ops. VoiceConnection gives them to VoiceE2eeDelegate.handle. */
export type VoiceE2eeServerOp =
  | {
      op: 'e2ee_roster'
      d: {
        groupId: B64url
        epoch: number | null
        committer: string | null
        create: boolean
        members: VoiceRosterEntry[]
        pending: Omit<VoiceRosterEntry, 'leafIndex'>[]
        departed: VoiceRosterEntry[]
      }
    }
  | { op: 'e2ee_key_package'; d: { sessionId: string; userId: string; deviceId: string; keyPackage: B64url } }
  | { op: 'e2ee_commit_rejected'; d: { epoch: number; currentEpoch: number } }
  | { op: 'e2ee_prepare_transition'; d: { transitionId: number; epoch: number; commit: B64url } }
  | { op: 'e2ee_welcome'; d: { transitionId: number; epoch: number; welcome: B64url } }
  | { op: 'e2ee_ratchet_tree'; d: { transitionId: number; epoch: number; ratchetTree: B64url } }
  | { op: 'e2ee_execute_transition'; d: { transitionId: number; epoch: number } }

/** Client → media e2ee ops, from VoiceE2eeDelegate.handle. */
export type VoiceE2eeClientOp =
  | {
      op: 'e2ee_commit'
      d: { epoch: number; commit: B64url; welcome: B64url | null; added: string[]; removed: string[] }
    }
  | { op: 'e2ee_ratchet_tree'; d: { epoch: number; ratchetTree: B64url } }
  | { op: 'e2ee_ready'; d: { transitionId: number | null; epoch: number; leafIndex: number } }
  /** committerLeaf: the sender leaf of the commit that failed (§8 "Bad commits"). */
  | { op: 'e2ee_invalid'; d: { transitionId: number | null; reason: string; committerLeaf: number | null } }

export type VoiceClientFrame =
  | { op: 'identify'; d: { token: string; e2ee: { version: 1; keyPackage: B64url } } }
  | { op: 'answer'; d: { sdp: string } }
  | { op: 'candidate'; d: { candidate: RTCIceCandidateInit | null } }
  | { op: 'speaking'; d: { speaking: boolean } }
  | { op: 'screen_subscribe'; d: { userIds: string[] } }
  | VoiceE2eeClientOp

export type VoiceServerFrame =
  | { op: 'ready'; d: { sessionId: string; ssrc: number } }
  | { op: 'offer'; d: { sdp: string } }
  | { op: 'candidate'; d: { candidate: RTCIceCandidateInit | null } }
  | { op: 'peers'; d: { peers: { userId: string; ssrc: number }[] } }
  | { op: 'speaking'; d: { userId: string; speaking: boolean } }
  | VoiceE2eeServerOp
