/**
 * Takusen database schema. Contract: docs/gateway-protocol.md §3.
 *
 * Tables:
 *  - users, accounts, sessions, verificationTokens  — Auth.js v5 Drizzle adapter shape
 *  - regions, mediaNodes                            — voice placement registry
 *  - guilds, guildMembers, guildBans, channels, messages — the chat model
 *  - roles, memberRoles, permissionOverwrites       — Discord-style permissions
 *  - dmParticipants, invites, uploads
 *  - docPages, docUpdates, docSnapshots             — pages channels (§3 "Pages tables", schema-pages.ts)
 *  - readStates, channelPins, guildEvents, guildEventRsvps, userBlocks — schema-channel-state.ts
 *  - oidcClients, oidcAdapterPayloads, passwordResetTokens — schema-auth.ts
 *  - the E2EE tables (§3 "E2EE tables", §12): devices and keys, the MLS delivery
 *    service, the device inbox, backups, device linking, key transparency,
 *    signed admin actions and message reports
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import type { AdapterAccountType } from 'next-auth/adapters'

import { bytea } from './columns'
import { docPages } from './schema-pages'

export { bytea } from './columns'
export * from './schema-pages'
export * from './schema-auth'
export * from './schema-channel-state'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])
export const channelTypeEnum = pgEnum('channel_type', ['text', 'voice', 'category', 'dm', 'group_dm', 'pages', 'thread'])
export const overwriteTypeEnum = pgEnum('overwrite_type', ['role', 'member'])
export const uploadPurposeEnum = pgEnum('upload_purpose', ['attachment', 'image', 'page_snapshot', 'page_media', 'sound', 'emoji'])

// E2EE enums (§3).
export const deviceStatusEnum = pgEnum('device_status', ['pending', 'active', 'revoked'])
export const devicePlatformEnum = pgEnum('device_platform', ['electron', 'browser', 'ios'])
export const revokeReasonEnum = pgEnum('revoke_reason', ['user', 'lost', 'password_reset', 'compromised', 'signed_out'])
export const mlsGroupKindEnum = pgEnum('mls_group_kind', ['public_set', 'channel', 'dm'])
export const mlsGroupStatusEnum = pgEnum('mls_group_status', ['pending', 'active', 'retired'])
export const historyVisibilityEnum = pgEnum('history_visibility', ['joined', 'shared'])
export const handshakeKindEnum = pgEnum('handshake_kind', ['commit', 'external_commit', 'proposal'])
export const pendingOpEnum = pgEnum('pending_op', ['add', 'remove'])
export const pendingStatusEnum = pgEnum('pending_status', ['queued', 'assigned', 'rejected'])
export const joinStatusEnum = pgEnum('join_status', ['queued', 'committed', 'rejected', 'external_commit', 'waiting'])
export const inboxKindEnum = pgEnum('inbox_kind', ['welcome', 'dsk_transfer', 'history_keys'])
export const backupKindEnum = pgEnum('backup_kind', ['identity', 'history'])

// ---------------------------------------------------------------------------
// Auth.js core tables (users, accounts, sessions, verificationTokens)
// Extended with Takusen-specific columns (role, passwordHash, displayName).
// ---------------------------------------------------------------------------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Auth.js expects a `name` and `image` column; we keep them so the adapter
  // can populate from OAuth profiles, but `displayName` is the canonical
  // user-facing handle.
  name: text('name'),
  image: text('image'),
  // Stored lowercased at the application layer; kept as `text` rather than
  // `citext` because the Auth.js Drizzle adapter's type checker rejects the
  // PgCustomColumn variant for this field.
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { withTimezone: true, mode: 'date' }),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
  passwordHash: text('password_hash'),
  // Null for accounts from before the column: the dashboard then shows no date.
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true, mode: 'date' }),
  displayName: text('display_name').notNull(),
  role: userRoleEnum('role').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

export const accounts = pgTable(
  'accounts',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
  ],
)

export const sessions = pgTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
})

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.identifier, table.token] })],
)

// ---------------------------------------------------------------------------
// Regions — the logical voice-placement regions a guild can be homed in.
//
// This is a small, fixed reference table (seeded by db:seed): "us-east",
// "us-west", "eu-west", "ap-southeast", etc. Media nodes register into a
// region; `guilds.region` biases voice placement toward it.
//
// `lat`/`lon` are nullable and exist purely so a future geodesic scorer can
// place a guild near its users for low latency. Nothing reads them today.
// ---------------------------------------------------------------------------
export const regions = pgTable('regions', {
  // Stable machine code, e.g. "us-east". Primary key so `guilds.region` can
  // reference it directly and so seeds are idempotent on the code.
  code: text('code').primaryKey(),
  displayName: text('display_name').notNull(),
  // Rough geographic centroid of the region. Nullable: future geodesic
  // scoring only; double precision to match Postgres `float8`.
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  // Endpoint a latency-capable client probes to measure client→region RTT (see
  // the Electron region probe and `/api/v1/regions/recommend`). Nullable
  // because the real managed-infra hosts don't exist yet — until then the seed
  // fills dev placeholders.
  probeHost: text('probe_host'),
  probePort: integer('probe_port').notNull().default(443),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// Guilds — a guild is just rows: creating one boots no process. The @everyone
// role shares the guild's id (see `roles`).
// ---------------------------------------------------------------------------
export const guilds = pgTable('guilds', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  // icon and banner hold upload keys (contract §4 Files).
  icon: text('icon'),
  banner: text('banner'),
  // Home voice region; placement prefers media nodes here.
  region: text('region').references(() => regions.code, { onDelete: 'set null' }),
  // Blob bytes of the page_snapshot and page_media uploads of the guild's pages (the page quota, §4 Pages).
  pageStorageBytes: bigint('page_storage_bytes', { mode: 'number' }).notNull().default(0),
  // The text channel that shows a line when a member joins (§4 Guilds). Null: no welcome lines.
  welcomeChannelId: uuid('welcome_channel_id').references((): AnyPgColumn => channels.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

export const guildMembers = pgTable(
  'guild_members',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nick: text('nick'),
    joinedAt: timestamp('joined_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    // Server mute and deafen (MUTE_MEMBERS / DEAFEN_MEMBERS). They stay across calls, as in Discord.
    mute: boolean('mute').notNull().default(false),
    deaf: boolean('deaf').notNull().default(false),
    // The invite of the join. The redeemer of an invite with history gets its bundles (§12.11.4).
    inviteId: uuid('invite_id').references((): AnyPgColumn => invites.id, { onDelete: 'set null' }),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.userId] }),
    // The ON DELETE SET NULL of each deleted invite looks up its members here.
    index('guild_members_invite_idx').on(table.inviteId).where(sql`${table.inviteId} is not null`),
  ],
)

// A ban keeps the user out of the guild: the invite accept refuses them (§4 Bans).
// No row for a member: the ban removes the membership in the same transaction.
export const guildBans = pgTable(
  'guild_bans',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: text('reason'),
    bannedBy: uuid('banned_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.userId] })],
)

// Guild channels (guildId set) and DMs (guildId null, participants in
// `dm_participants`). `ownerId` is only meaningful for group_dm.
export const channels = pgTable(
  'channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: uuid('guild_id').references(() => guilds.id, { onDelete: 'cascade' }),
    type: channelTypeEnum('type').notNull(),
    name: text('name'),
    topic: text('topic'),
    parentId: uuid('parent_id').references((): AnyPgColumn => channels.id, {
      onDelete: 'set null',
    }),
    position: integer('position').notNull().default(0),
    ownerId: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),
    // The current MLS group of a text, pages, dm or group_dm channel (§12.6).
    mlsGroupId: bytea('mls_group_id').references((): AnyPgColumn => mlsGroups.groupId, { onDelete: 'set null' }),
    // A thread: the message in the parent channel that starts the thread (an id only).
    threadStartMessageId: uuid('thread_start_message_id').references((): AnyPgColumn => messages.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    // A thread: the time of its last message, else created_at. It orders the thread lists (§4 Threads, §5 READY).
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('channels_guild_id_idx').on(table.guildId),
    index('channels_parent_activity_idx').on(table.parentId, table.lastActivityAt),
    index('channels_guild_thread_activity_idx').on(table.guildId, table.lastActivityAt).where(sql`${table.type} = 'thread'`),
  ],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Ciphertext only (§12.8). Takusen reads the envelope header, never the content.
    groupId: bytea('group_id')
      .notNull()
      .references((): AnyPgColumn => mlsGroups.groupId, { onDelete: 'cascade' }),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    senderDevice: uuid('sender_device').references((): AnyPgColumn => devices.id, { onDelete: 'set null' }),
    clientMsgId: bytea('client_msg_id').notNull(),
    envelope: bytea('envelope').notNull(),
    frankingTag: bytea('franking_tag').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
  },
  // Backs the `?before=` cursor: (created_at, id) < cursor ORDER BY both DESC.
  (table) => [
    index('messages_channel_created_idx').on(
      table.channelId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    uniqueIndex('messages_channel_client_msg_id_uq').on(table.channelId, table.clientMsgId),
  ],
)

export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: integer('color').notNull().default(0),
    // Shown as its own group in the member list (N15). Changes no permission.
    hoist: boolean('hoist').notNull().default(false),
    position: integer('position').notNull().default(0),
    permissions: bigint('permissions', { mode: 'number' }).notNull().default(0),
  },
  (table) => [index('roles_guild_id_idx').on(table.guildId)],
)

// Membership in a role. The composite FK to guild_members drops a member's
// roles when they leave; @everyone is implicit and never stored here.
export const memberRoles = pgTable(
  'member_roles',
  {
    guildId: uuid('guild_id').notNull(),
    userId: uuid('user_id').notNull(),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.roleId] }),
    foreignKey({
      columns: [table.guildId, table.userId],
      foreignColumns: [guildMembers.guildId, guildMembers.userId],
    }).onDelete('cascade'),
  ],
)

// `targetId` is a role id or a user id depending on `targetType`, so it has no FK.
export const permissionOverwrites = pgTable(
  'permission_overwrites',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    targetId: uuid('target_id').notNull(),
    targetType: overwriteTypeEnum('target_type').notNull(),
    allow: bigint('allow', { mode: 'number' }).notNull().default(0),
    deny: bigint('deny', { mode: 'number' }).notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.targetId] })],
)

export const dmParticipants = pgTable(
  'dm_participants',
  {
    channelId: uuid('channel_id')
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.userId] }),
    index('dm_participants_user_id_idx').on(table.userId),
  ],
)

export const invites = pgTable(
  'invites',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull().unique(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    revoked: boolean('revoked').notNull().default(false),
    // An invite with history (§12.11.4): the SignedInviteRecord and its key id (sign_public).
    record: bytea('record'),
    keyId: bytea('key_id'),
    // The accept of the last use sets it. The bundle sweep keys on it.
    exhaustedAt: timestamp('exhausted_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('invites_guild_idx').on(table.guildId), uniqueIndex('invites_key_id_uq').on(table.keyId)],
)

// The sealed epoch secrets of an invite with history (§12.11.4). Takusen cannot open them.
export const inviteBundles = pgTable(
  'invite_bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    inviteId: uuid('invite_id')
      .notNull()
      .references(() => invites.id, { onDelete: 'cascade' }),
    groupId: bytea('group_id').notNull(),
    epoch: integer('epoch').notNull(),
    senderDevice: uuid('sender_device').notNull(),
    // The share of one member (§12.12) counts all its devices, also revoked ones.
    senderUser: uuid('sender_user').notNull(),
    blob: bytea('blob').notNull(),
    size: integer('size').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('invite_bundles_invite_created_idx').on(table.inviteId, table.createdAt)],
)

// One row per stored object (contract §4 Files). `purpose` is set by the first
// claim and never changes: deleting a message deletes its objects, so an
// attachment must never also be an avatar, icon or banner.
export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    uploaderId: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    key: text('key').notNull().unique(),
    // Null for encrypted blobs: the name is only in the envelope (§12.9).
    filename: text('filename'),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    encrypted: boolean('encrypted').notNull().default(false),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    purpose: uploadPurposeEnum('purpose'),
    // page_snapshot and page_media: the page that claimed the upload (§4 Pages). A page_snapshot
    // upload has the purpose from the upload on, and page_id only after the claim.
    pageId: uuid('page_id').references((): AnyPgColumn => docPages.id, { onDelete: 'cascade' }),
    // page_media: the last claim. The media sweep keeps an upload with a recent reference.
    lastReferencedAt: timestamp('last_referenced_at', { withTimezone: true, mode: 'date' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('uploads_message_id_idx').on(table.messageId),
    index('uploads_page_id_idx').on(table.pageId),
    // IS NOT DISTINCT FROM keeps an unclaimed row (purpose null) from having a message.
    check(
      'uploads_attachment_has_message',
      sql`(${table.purpose} is not distinct from 'attachment') = (${table.messageId} is not null)`,
    ),
    check(
      'uploads_page_media_has_page',
      sql`${table.purpose} is distinct from 'page_media' or ${table.pageId} is not null`,
    ),
    check(
      'uploads_page_id_is_page_purpose',
      sql`${table.pageId} is null or ${table.purpose} in ('page_snapshot', 'page_media')`,
    ),
  ],
)

// Custom guild emojis (§4 Emojis). Plaintext, like the guild icon: the image is an
// `emoji` upload, and messages name an emoji as `<:name:id>` inside the envelope.
export const guildEmojis = pgTable(
  'guild_emojis',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    uploadId: uuid('upload_id')
      .notNull()
      .unique()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('guild_emojis_guild_name_idx').on(table.guildId, table.name)],
)

// ---------------------------------------------------------------------------
// Inferred row types — re-export for downstream consumers.
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Region = typeof regions.$inferSelect
export type NewRegion = typeof regions.$inferInsert
export type GuildRow = typeof guilds.$inferSelect
export type GuildMemberRow = typeof guildMembers.$inferSelect
export type ChannelRow = typeof channels.$inferSelect
export type ChannelTypeValue = (typeof channelTypeEnum.enumValues)[number]
export type MessageRow = typeof messages.$inferSelect
export type RoleRow = typeof roles.$inferSelect
export type MemberRoleRow = typeof memberRoles.$inferSelect
export type PermissionOverwriteRow = typeof permissionOverwrites.$inferSelect
export type DmParticipantRow = typeof dmParticipants.$inferSelect
export type InviteRow = typeof invites.$inferSelect
export type InviteBundleRow = typeof inviteBundles.$inferSelect
export type UploadRow = typeof uploads.$inferSelect
export type GuildEmojiRow = typeof guildEmojis.$inferSelect

// ---------------------------------------------------------------------------
// Media nodes — placement registry for the WebRTC SFU plane.
//
// hachiman-media instances self-register with Takusen on boot and heartbeat
// liveness. The placement scorer reads this table when hachiman-gateway calls
// `PlaceMediaSession` (management.proto).
//
// `capacity` is stored as jsonb so the descriptor can grow with the per-node
// resource model without a schema change (today it stores `{cpu_cores, max_sessions}`;
// later passes add network egress caps, per-codec encode budgets, etc.).
//
// `status` is a free text column (enum-as-varchar) — keeps drizzle migrations
// simple while still letting placement scorers branch on a stable set
// ("active" | "draining" | "dead").
// ---------------------------------------------------------------------------
export const mediaNodes = pgTable(
  'media_nodes',
  {
    // Node-generated UUID (string PK rather than uuid() because the node sets it,
    // not Postgres). Stable for a node's lifetime; on partition + reconnect the
    // node re-registers with the same id.
    nodeId: text('node_id').primaryKey(),
    region: text('region').notNull(),
    capacity: jsonb('capacity').$type<{ cpu_cores: number; max_sessions: number }>().notNull(),
    // Live counter reported in each heartbeat. Placement scoring picks the
    // lowest-loaded node within the region (MediaNodesRepo in src/grpc/repo.ts). A
    // simplification: heartbeat-reported value rather than a derived
    // aggregate over an active-sessions table — keeps the schema flat. Defaults
    // to 0 so the first register-without-heartbeat row scores as empty.
    activeSessions: integer('active_sessions').notNull().default(0),
    // CPU fraction reported in each heartbeat. Node placement does not read
    // it yet: it ranks by active_sessions, then node_id.
    cpuFraction: doublePrecision('cpu_fraction').notNull().default(0),
    lastHeartbeatAt: timestamp('last_heartbeat_at', { withTimezone: true, mode: 'date' }).notNull(),
    version: text('version').notNull(),
    status: text('status').notNull(),
    // Set by an admin (PATCH /api/admin/media-nodes/:nodeId). Holds `status`
    // at 'draining' through heartbeats and re-registers until cleared.
    adminDrain: boolean('admin_drain').notNull().default(false),
    // The node's client-facing voice WebSocket URL (e.g.
    // wss://media-1.example.com/voice). Mirrored from RegisterMediaNode;
    // returned by PlaceMediaSession so the gateway can hand it to clients as
    // VOICE_SERVER_UPDATE.endpoint.
    signalingUrl: text('signaling_url').notNull().default(''),
  },
  (table) => [
    // Composite index covering the pickPlacement filter:
    //   WHERE region = $1 AND status = 'active' AND last_heartbeat_at > $cutoff
    //   ORDER BY active_sessions ASC, node_id ASC LIMIT 1
    // Postgres uses the leading region-prefix for equality, then status, then
    // a range scan on last_heartbeat_at. The ORDER BY runs on the already-
    // narrow result set; an extra include on active_sessions would help only
    // at very large fleet sizes — keep this index lean for now.
    index('idx_media_nodes_placement').on(
      table.region,
      table.status,
      table.lastHeartbeatAt,
    ),
  ],
)

export type MediaNode = typeof mediaNodes.$inferSelect
export type NewMediaNode = typeof mediaNodes.$inferInsert

// ---------------------------------------------------------------------------
// End-to-end encryption (docs/gateway-protocol.md §3 "E2EE tables", §12).
// The DS code in src/lib/mls/ reaches these tables only through MlsRepo
// (repo.drizzle.ts). Keep repo.in-memory.ts in step with every change here.
// ---------------------------------------------------------------------------

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow()

export const devices = pgTable(
  'devices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: deviceStatusEnum('status').notNull().default('pending'),
    name: text('name').notNull(),
    platform: devicePlatformEnum('platform').notNull(),
    clientVersion: text('client_version').notNull(),
    certificate: bytea('certificate'),
    mlsSignatureKey: bytea('mls_signature_key'),
    hpkeKey: bytea('hpke_key'),
    dskGeneration: integer('dsk_generation'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [index('devices_user_id_idx').on(table.userId)],
)

export const deviceRevocations = pgTable('device_revocations', {
  deviceId: uuid('device_id')
    .primaryKey()
    .references(() => devices.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reason: revokeReasonEnum('reason').notNull(),
  // Null for a server revocation (password reset, or a pending device that signs out).
  revocation: bytea('revocation'),
  createdAt: createdAt(),
})

export const masterKeys = pgTable(
  'master_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    publicKey: bytea('public_key').notNull(),
    record: bytea('record').notNull(),
    createdAt: createdAt(),
    supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.generation] })],
)

export const deviceSigningKeys = pgTable(
  'device_signing_keys',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    masterGeneration: integer('master_generation').notNull(),
    publicKey: bytea('public_key').notNull(),
    cert: bytea('cert').notNull(),
    createdAt: createdAt(),
    supersededAt: timestamp('superseded_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.generation] })],
)

export const keyPackages = pgTable(
  'key_packages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    cipherSuite: integer('cipher_suite').notNull(),
    ref: bytea('ref').notNull().unique(),
    data: bytea('data').notNull(),
    lastResort: boolean('last_resort').notNull().default(false),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [
    index('key_packages_claim_idx').on(table.deviceId, table.cipherSuite, table.lastResort, table.createdAt),
    uniqueIndex('key_packages_last_resort_uq')
      .on(table.deviceId, table.cipherSuite)
      .where(sql`${table.lastResort}`),
  ],
)

export const mlsGroups = pgTable(
  'mls_groups',
  {
    groupId: bytea('group_id').primaryKey(),
    kind: mlsGroupKindEnum('kind').notNull(),
    scopeId: uuid('scope_id').notNull(),
    guildId: uuid('guild_id').references(() => guilds.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').references((): AnyPgColumn => channels.id, { onDelete: 'cascade' }),
    generation: integer('generation').notNull(),
    cipherSuite: integer('cipher_suite').notNull(),
    status: mlsGroupStatusEnum('status').notNull(),
    epoch: bigint('epoch', { mode: 'number' }),
    groupInfo: bytea('group_info'),
    ratchetTree: bytea('ratchet_tree'),
    historyVisibility: historyVisibilityEnum('history_visibility').notNull(),
    epochStartedAt: timestamp('epoch_started_at', { withTimezone: true, mode: 'date' }),
    lastCommitRemoved: boolean('last_commit_removed').notNull().default(false),
    latestSeq: bigint('latest_seq', { mode: 'number' }).notNull().default(0),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('mls_groups_kind_scope_generation_uq').on(table.kind, table.scopeId, table.generation),
    index('mls_groups_guild_id_idx').on(table.guildId),
    index('mls_groups_channel_id_idx').on(table.channelId),
  ],
)

export const mlsGroupEpochs = pgTable(
  'mls_group_epochs',
  {
    groupId: bytea('group_id')
      .notNull()
      .references(() => mlsGroups.groupId, { onDelete: 'cascade' }),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    groupInfo: bytea('group_info').notNull(),
    ratchetTree: bytea('ratchet_tree').notNull(),
    treeHash: bytea('tree_hash').notNull(),
    confirmedTranscriptHash: bytea('confirmed_transcript_hash').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.groupId, table.epoch] })],
)

// The DS roster. A row with a null device_id is the leaf of a deleted device;
// it stays until a commit removes the leaf (§12.7.3 check 8).
export const mlsGroupMembers = pgTable(
  'mls_group_members',
  {
    groupId: bytea('group_id')
      .notNull()
      .references(() => mlsGroups.groupId, { onDelete: 'cascade' }),
    leafIndex: integer('leaf_index').notNull(),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    credentialIdentity: text('credential_identity').notNull(),
    signatureKey: bytea('signature_key').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.leafIndex] }),
    uniqueIndex('mls_group_members_group_device_uq').on(table.groupId, table.deviceId),
    index('mls_group_members_device_id_idx').on(table.deviceId),
  ],
)

export const mlsHandshakes = pgTable(
  'mls_handshakes',
  {
    groupId: bytea('group_id')
      .notNull()
      .references(() => mlsGroups.groupId, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    kind: handshakeKindEnum('kind').notNull(),
    senderDevice: uuid('sender_device').references(() => devices.id, { onDelete: 'set null' }),
    message: bytea('message').notNull(),
    treeHash: bytea('tree_hash'),
    confirmedTranscriptHash: bytea('confirmed_transcript_hash'),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.groupId, table.seq] }),
    index('mls_handshakes_created_at_idx').on(table.createdAt),
  ],
)

export const mlsJoinRequests = pgTable(
  'mls_join_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: bytea('group_id')
      .notNull()
      .references(() => mlsGroups.groupId, { onDelete: 'cascade' }),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyPackage: bytea('key_package').notNull(),
    status: joinStatusEnum('status').notNull(),
    reason: text('reason'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('mls_join_requests_device_id_idx').on(table.deviceId)],
)

// A Remove is keyed by leaf_index, so it survives the delete of its user or
// device (the FKs set them to null). `proposal` is the one signed external
// proposal for `proposal_epoch` (§12.7.4).
export const mlsPending = pgTable(
  'mls_pending',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: bytea('group_id')
      .notNull()
      .references(() => mlsGroups.groupId, { onDelete: 'cascade' }),
    op: pendingOpEnum('op').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    deviceId: uuid('device_id').references(() => devices.id, { onDelete: 'set null' }),
    leafIndex: integer('leaf_index'),
    keyPackage: bytea('key_package'),
    joinRequestId: uuid('join_request_id').references(() => mlsJoinRequests.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    status: pendingStatusEnum('status').notNull().default('queued'),
    proposal: bytea('proposal'),
    proposalEpoch: bigint('proposal_epoch', { mode: 'number' }),
    proposalRef: bytea('proposal_ref'),
    createdAt: createdAt(),
  },
  (table) => [
    index('mls_pending_group_status_idx').on(table.groupId, table.status),
    uniqueIndex('mls_pending_open_remove_uq')
      .on(table.groupId, table.leafIndex)
      .where(sql`${table.op} = 'remove' and ${table.status} <> 'rejected'`),
  ],
)

export const mlsBatches = pgTable(
  'mls_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: bytea('group_id')
      .notNull()
      .references(() => mlsGroups.groupId, { onDelete: 'cascade' }),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    pendingIds: uuid('pending_ids').array().notNull(),
    timedOutDevices: uuid('timed_out_devices').array().notNull().default(sql`'{}'::uuid[]`),
    deadlineAt: timestamp('deadline_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('mls_batches_group_id_idx').on(table.groupId)],
)

export const deviceInbox = pgTable(
  'device_inbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    deviceId: uuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    kind: inboxKindEnum('kind').notNull(),
    senderDevice: uuid('sender_device').references(() => devices.id, { onDelete: 'set null' }),
    body: bytea('body').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (table) => [index('device_inbox_device_seq_idx').on(table.deviceId, table.seq)],
)

export const keyBackups = pgTable(
  'key_backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    keyId: bytea('key_id').notNull(),
    kind: backupKindEnum('kind').notNull(),
    groupId: bytea('group_id'),
    epochFrom: bigint('epoch_from', { mode: 'number' }),
    epochTo: bigint('epoch_to', { mode: 'number' }),
    blob: bytea('blob').notNull(),
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    index('key_backups_user_id_idx').on(table.userId),
    uniqueIndex('key_backups_identity_uq').on(table.userId).where(sql`${table.kind} = 'identity'`),
  ],
)

export const historyBundles = pgTable(
  'history_bundles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    groupId: bytea('group_id')
      .notNull()
      .references(() => mlsGroups.groupId, { onDelete: 'cascade' }),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    senderDevice: uuid('sender_device')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    blob: bytea('blob').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('history_bundles_group_epoch_sender_uq').on(table.groupId, table.epoch, table.senderDevice)],
)

export const deviceLinkSessions = pgTable('device_link_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  newDeviceId: uuid('new_device_id')
    .notNull()
    .references(() => devices.id, { onDelete: 'cascade' }),
  offer: bytea('offer').notNull(),
  createdAt: createdAt(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
})

export const deviceLinkMessages = pgTable(
  'device_link_messages',
  {
    sessionId: uuid('session_id')
      .notNull()
      .references(() => deviceLinkSessions.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    fromDevice: uuid('from_device')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    body: bytea('body').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.seq] })],
)

// Append-only: no FK to users, so a user delete keeps the log intact (§12.14).
export const ktEntries = pgTable(
  'kt_entries',
  {
    idx: bigint('idx', { mode: 'number' }).primaryKey(),
    userId: uuid('user_id').notNull(),
    type: smallint('type').notNull(),
    entry: bytea('entry').notNull(),
    leafHash: bytea('leaf_hash').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('kt_entries_user_idx').on(table.userId, table.idx)],
)

// Only the gRPC process signs heads (§12.14).
export const ktTreeHeads = pgTable('kt_tree_heads', {
  treeSize: bigint('tree_size', { mode: 'number' }).primaryKey(),
  rootHash: bytea('root_hash').notNull(),
  signed: bytea('signed').notNull(),
  createdAt: createdAt(),
  publishedAt: timestamp('published_at', { withTimezone: true, mode: 'date' }),
})

export const adminActions = pgTable(
  'admin_actions',
  {
    guildId: uuid('guild_id')
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    seq: bigint('seq', { mode: 'number' }).notNull(),
    action: bytea('action').notNull(),
    hash: bytea('hash').notNull(),
    actorUserId: uuid('actor_user_id').notNull(),
    createdAt: createdAt(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.seq] })],
)

export const messageReports = pgTable('message_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
  channelId: uuid('channel_id').notNull(),
  reporterId: uuid('reporter_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  reason: text('reason').notNull(),
  content: bytea('content').notNull(),
  frankingKey: bytea('franking_key').notNull(),
  verified: boolean('verified').notNull(),
  createdAt: createdAt(),
})

/** One push target per device (§4 Push): an APNs token or a Web Push endpoint. */
export const pushTargets = pgTable(
  'push_targets',
  {
    deviceId: uuid('device_id')
      .primaryKey()
      .references(() => devices.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['apns', 'webpush'] }).notNull(),
    /** APNs: the hex device token. Web Push: the endpoint URL. */
    token: text('token').notNull(),
    /** APNs only: the token is for the development (sandbox) environment. */
    sandbox: boolean('sandbox').notNull().default(false),
    createdAt: createdAt(),
  },
  (table) => [index('push_targets_user_id_idx').on(table.userId)],
)

export type DeviceDbRow = typeof devices.$inferSelect
export type MlsGroupDbRow = typeof mlsGroups.$inferSelect
export type AdminActionRow = typeof adminActions.$inferSelect
export type MessageReportRow = typeof messageReports.$inferSelect
