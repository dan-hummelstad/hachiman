/**
 * Takusen database schema. Contract: docs/gateway-protocol.md §3.
 *
 * Tables:
 *  - users, accounts, sessions, verificationTokens  — Auth.js v5 Drizzle adapter shape
 *  - regions, mediaNodes                            — voice placement registry
 *  - guilds, guildMembers, channels, messages       — the chat model
 *  - roles, memberRoles, permissionOverwrites       — Discord-style permissions
 *  - dmParticipants, invites, uploads
 *  - oidcClients, oidcAdapterPayloads, passwordResetTokens
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
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core'
import type { AdapterAccountType } from 'next-auth/adapters'

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])
export const channelTypeEnum = pgEnum('channel_type', ['text', 'voice', 'category', 'dm', 'group_dm'])
export const overwriteTypeEnum = pgEnum('overwrite_type', ['role', 'member'])
export const uploadPurposeEnum = pgEnum('upload_purpose', ['attachment', 'image'])

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
// OIDC clients. Today only public first-party clients exist (isPublic = true,
// clientSecret empty): the Hachiman desktop/browser apps use them for end-user
// PKCE sign-in. PKCE is globally required in oidc-provider, so a public client
// with token_endpoint_auth_method='none' is safe — the code interception
// window is closed by the PKCE binding.
// ---------------------------------------------------------------------------
export const oidcClients = pgTable(
  'oidc_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull().unique(),
    // Empty string for public clients. NEVER store an actual secret here for
    // a row where isPublic = true; the adapter omits the field entirely from
    // the metadata it hands to oidc-provider.
    clientSecret: text('client_secret').notNull(),
    isPublic: boolean('is_public').notNull().default(false),
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    scopes: jsonb('scopes')
      .$type<string[]>()
      .notNull()
      .default(sql`'["openid","profile","email"]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
)

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
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [index('channels_guild_id_idx').on(table.guildId)],
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
    content: text('content').notNull(),
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

export const invites = pgTable('invites', {
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
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

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
    filename: text('filename').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
    contentType: text('content_type').notNull(),
    width: integer('width'),
    height: integer('height'),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'cascade' }),
    position: integer('position').notNull().default(0),
    purpose: uploadPurposeEnum('purpose'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('uploads_message_id_idx').on(table.messageId),
    // IS NOT DISTINCT FROM keeps an unclaimed row (purpose null) from having a message.
    check(
      'uploads_attachment_has_message',
      sql`(${table.purpose} is not distinct from 'attachment') = (${table.messageId} is not null)`,
    ),
  ],
)

// ---------------------------------------------------------------------------
// Inferred row types — re-export for downstream consumers.
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Region = typeof regions.$inferSelect
export type NewRegion = typeof regions.$inferInsert
export type OidcClient = typeof oidcClients.$inferSelect
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
export type UploadRow = typeof uploads.$inferSelect

// ===== Auth UI agent additions =====
// Password reset tokens — short-lived (e.g. 1h) one-time tokens. We store only
// the SHA-256 hash so a database leak can't be used to reset accounts.
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert

// ===== OIDC provider agent additions =====
// Generic key/value store for the panva oidc-provider Adapter contract.
// One row per (model, id) pair: sessions, authorization codes, access &
// refresh tokens, grants, interactions, replay-detection entries, etc.
//
// Indexing rationale:
//  - (model, uid)        — Session/Interaction lookup by `uid`
//  - (model, userCode)   — device-flow lookup (unused today, cheap to keep)
//  - (grantId)           — `revokeByGrantId` cascade
//  - (expiresAt)         — background sweeper of expired rows
//
// `Client` is intentionally NOT stored here — the adapter shims those reads
// straight from `oidcClients`. Adapter writes for the Client model are no-ops.
// ---------------------------------------------------------------------------
export const oidcAdapterPayloads = pgTable(
  'oidc_adapter_payloads',
  {
    id: text('id').notNull(),
    model: text('model').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    grantId: text('grant_id'),
    userCode: text('user_code'),
    uid: text('uid'),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    consumedAt: timestamp('consumed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    primaryKey({ columns: [table.model, table.id] }),
    index('oidc_adapter_payloads_model_uid_idx').on(table.model, table.uid),
    index('oidc_adapter_payloads_model_user_code_idx').on(table.model, table.userCode),
    index('oidc_adapter_payloads_grant_id_idx').on(table.grantId),
    index('oidc_adapter_payloads_expires_at_idx').on(table.expiresAt),
  ],
)

export type OidcAdapterPayload = typeof oidcAdapterPayloads.$inferSelect
export type NewOidcAdapterPayload = typeof oidcAdapterPayloads.$inferInsert

// ---------------------------------------------------------------------------
// Media nodes — placement registry for the WebRTC SFU plane.
//
// hachiman-media instances self-register with Takusen on boot and heartbeat
// liveness. The placement scorer reads this table when hachiman-gateway calls
// `PlaceMediaSession` (management.proto).
//
// `capacity` is stored as jsonb so the descriptor can grow with the per-node
// resource model without a schema change (phase 1 stores `{cpu_cores, max_sessions}`;
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
    // lowest-loaded node within the region (cf. PlacementService below). Phase
    // 3a simplification: heartbeat-reported value rather than a derived
    // aggregate over an active-sessions table — keeps the schema flat. Defaults
    // to 0 so the first register-without-heartbeat row scores as empty.
    activeSessions: integer('active_sessions').notNull().default(0),
    // CPU fraction reported in each heartbeat. Placement uses it only as a
    // secondary tiebreaker today; phase 4 weights it into the scorer.
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
