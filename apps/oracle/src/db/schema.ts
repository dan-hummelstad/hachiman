/**
 * Oracle / Takusen database schema.
 *
 * Tables:
 *  - users, accounts, sessions, verificationTokens  — Auth.js v5 Drizzle adapter shape
 *  - servers                                        — registered Mumble servers
 *  - serverDomainVerifications                      — DNS TXT verification history
 *  - oidcClients                                    — one OIDC client per server
 *  - inviteCodes                                    — short codes redeemable into takusen:// URIs
 *
 * Note: `citext` is enabled via a SQL migration in `drizzle/` (drizzle-kit
 * generate will pick up the `customType` and emit the extension on first
 * migration).
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  customType,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import type { AdapterAccountType } from 'next-auth/adapters'

// ---------------------------------------------------------------------------
// citext (case-insensitive text) — Postgres extension. Requires
//   CREATE EXTENSION IF NOT EXISTS citext;
// to be present in the database (drizzle-kit's generated SQL will need a
// manual edit on first migration, or run it once in db:migrate bootstrap).
// ---------------------------------------------------------------------------
const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'citext'
  },
})

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const userRoleEnum = pgEnum('user_role', ['user', 'admin'])

// Island lifecycle (the physical Murmur host process). See ISLAND-PLATFORM.md.
//   provisioning — the k3s pod is being brought up; not yet placement-eligible
//   active       — healthy and accepting vServer placements
//   draining     — no NEW placements; existing vServers migrate off before down
//   down         — unhealthy / terminated; the scheduler skips it
export const islandStatusEnum = pgEnum('island_status', [
  'provisioning',
  'active',
  'draining',
  'down',
])

// Virtual-server lifecycle. The valid transitions form a single cycle, enforced
// by `transitionVServer` in lib/virtual-servers.ts:
//   inactive → starting → active → cooling → inactive
//   inactive — provisioned but not running anywhere (islandId is typically null)
//   starting — placed on an island; the in-process Murmur vServer is booting
//   active   — running and accepting users
//   cooling  — drained of users, kept warm briefly before returning to inactive
export const virtualServerStatusEnum = pgEnum('virtual_server_status', [
  'inactive',
  'starting',
  'active',
  'cooling',
])

// ---------------------------------------------------------------------------
// Auth.js core tables (users, accounts, sessions, verificationTokens)
// Extended with Oracle-specific columns (role, passwordHash, displayName).
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
// Regions — the logical voice-placement regions a server can be homed in.
//
// This is a small, fixed reference table (seeded by db:seed): "us-east",
// "us-west", "eu-west", "ap-southeast", etc. A region is a *logical* location
// the owner re-selects; the future managed-infra layer maps a region to a
// physical island and, eventually, a placed vServer (see REGION-CONTRACT.md).
//
// `lat`/`lon` are nullable and exist purely so a future geodesic scorer can
// place/re-home a server near its users for low latency. Nothing in this layer
// reads them today.
// ---------------------------------------------------------------------------
export const regions = pgTable('regions', {
  // Stable machine code, e.g. "us-east". Primary key so `servers.region` can
  // reference it directly and so seeds are idempotent on the code.
  code: text('code').primaryKey(),
  displayName: text('display_name').notNull(),
  // Rough geographic centroid of the region. Nullable: future geodesic
  // scoring only; double precision to match Postgres `float8`.
  lat: doublePrecision('lat'),
  lon: doublePrecision('lon'),
  // Endpoint a latency-capable client probes to measure client→region RTT (see
  // the RTT prober in `@hachiman/hachiman-node` and `/api/servers/recommend-region`).
  // Nullable because the real managed-infra hosts don't exist yet — until then
  // the seed fills dev placeholders. `probePort` defaults to the Mumble port
  // (64738), the same port the server answers TLS/TCP and UDP browser-pings on.
  probeHost: text('probe_host'),
  probePort: integer('probe_port').notNull().default(64738),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// Virtual servers — the IDENTITY row for a registered Mumble server. Owns
// the cosmetic / addressable-by-name data (owner, slug, name, description,
// region, OracleOnly). Persistent across re-homes — FKs from invites, OIDC
// clients, and domain verifications all point here so they survive a change
// of host / port / island.
//
// Companion 1:1 row in `servers` (below) carries the physical placement
// (host / port / island / lifecycle / capacity).
// ---------------------------------------------------------------------------
export const virtualServers = pgTable(
  'virtual_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: citext('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    // When true, this server only accepts Oracle-authenticated clients.
    // Identity-layer concern: shapes auth-mode UX regardless of which
    // physical island is currently hosting. Owner-toggleable.
    oracleOnly: boolean('oracle_only').notNull().default(false),
    // Owner-selected voice region. MUTABLE: changing it is the re-home
    // trigger. Manual today via the admin "Place now" action; auto-on-
    // region-change is a future follow-up. Nullable for freshly-created
    // identity rows that haven't picked a region yet.
    region: text('region').references(() => regions.code, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('virtual_servers_slug_unique').on(table.slug)],
)

// ---------------------------------------------------------------------------
// Islands — a managed-infra control-plane row: ONE Murmur process (one k3s pod)
// that hosts MANY in-process virtual servers, living inside a region. This is
// the PHYSICAL layer the REGION-CONTRACT.md region→island→vServer model has so
// far left "Not modeled yet"; this slice realizes it.
//
// Only durable control-plane facts live here. LIVE metrics (active users, CPU,
// bandwidth) are NOT columns — they live in Redis and are fed to the bin-packing
// scheduler at scoring time (see ISLAND-PLATFORM.md). The scheduler keys
// placement off `id` / `host` / `grpcPort` / `region` / `maxVservers` plus the
// current vServer count (derived) and those Redis-supplied metrics.
// ---------------------------------------------------------------------------
export const islands = pgTable('islands', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Routable host of the island's Murmur pod (DNS name or IP). Future HAProxy
  // L4 mapping + DNS SRV records resolve a vServer's advertised endpoint here.
  host: text('host').notNull(),
  // Port of the island's control gRPC endpoint (the always-on wake proxy /
  // scheduler talks to this to start/stop in-process vServers). NOT the Mumble
  // voice port — each vServer carries its own `port`.
  grpcPort: integer('grpc_port').notNull(),
  // The region this island physically sits in. ON DELETE RESTRICT: a region
  // with live islands must not be deleted out from under them (unlike
  // servers.region, which SET NULLs — an island without a region is nonsense).
  region: text('region')
    .notNull()
    .references(() => regions.code, { onDelete: 'restrict' }),
  status: islandStatusEnum('status').notNull().default('provisioning'),
  // Hard cap on in-process vServers this island will host. The bin-packing
  // scheduler refuses to place beyond this; LIVE load (Redis) may push the
  // effective cap lower, but never higher.
  maxVservers: integer('max_vservers').notNull().default(50),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// Servers — the PHYSICAL placement / connection record for a virtual server.
// One row per identity row in `virtual_servers` (1:1 via the unique
// `virtualServerId` FK). Carries operational facts that change on a re-home
// without invalidating identity (host, port, island, lifecycle, capacity).
//
// Self-hosted entries: `islandId = null`, `host`/`port` owner-supplied.
// Managed entries:     `islandId` filled by the bin-packer, `host` from the
//                      gateway env, `port` allocated per vServer.
//
// Region intentionally lives on `virtual_servers`, NOT here — region is an
// owner-selected identity attribute, not a function of the current placement.
// The scheduler reads region by joining up to the identity row.
//
// LIVE metrics (active users / CPU / bandwidth) are NOT stored here; they
// live in Redis and are supplied to the bin-packing scheduler at scoring
// time (see ISLAND-PLATFORM.md).
// ---------------------------------------------------------------------------
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The identity row this placement backs. UNIQUE → strict 1:1.
  // ON DELETE CASCADE: deleting the virtual server tears down its placement
  // row too (runtime teardown is a separate, deferred concern).
  virtualServerId: uuid('virtual_server_id')
    .notNull()
    .unique()
    .references(() => virtualServers.id, { onDelete: 'cascade' }),
  status: virtualServerStatusEnum('status').notNull().default('inactive'),
  // Island placement. NULL = unplaced (awaiting/between scheduling, OR a
  // self-hosted server living on the owner's hardware). ON DELETE SET NULL:
  // removing an island row unplaces its vServers rather than deleting them.
  islandId: uuid('island_id').references(() => islands.id, { onDelete: 'set null' }),
  // The in-process vServer id WITHIN the island's Murmur process. NULL until
  // placed/assigned on an island, or permanently NULL for self-hosted.
  murmurId: integer('murmur_id'),
  // Mumble voice host the client connects to. Managed: gateway env. Self-
  // hosted: owner-supplied.
  host: text('host').notNull(),
  // Mumble voice port the client connects to. Managed: gateway-allocated.
  // Self-hosted: owner-supplied. Default 64738.
  port: integer('port').notNull().default(64738),
  // Per-vServer capacity caps the scheduler/runtime enforce.
  maxUsers: integer('max_users').notNull().default(100),
  // Bandwidth ceiling in bits/sec (matches Murmur's `bandwidth` semantics).
  maxBandwidth: integer('max_bandwidth').notNull().default(558000),
  // Last time this vServer had activity; drives the cooling→inactive sweep.
  lastActiveAt: timestamp('last_active_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// Server domain verifications — DNS TXT challenges. A server is considered
// "verified" iff there exists a row with verifiedAt IS NOT NULL for its
// current host. History is preserved so we can show audit trail / re-verify.
// ---------------------------------------------------------------------------
export const serverDomainVerifications = pgTable('server_domain_verifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  // FK to the identity row — verification survives a re-home; changing
  // the placement host doesn't invalidate proven domain control.
  virtualServerId: uuid('virtual_server_id')
    .notNull()
    .references(() => virtualServers.id, { onDelete: 'cascade' }),
  domain: text('domain').notNull(),
  txtToken: text('txt_token').notNull(),
  verifiedAt: timestamp('verified_at', { withTimezone: true, mode: 'date' }),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true, mode: 'date' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
})

// ---------------------------------------------------------------------------
// OIDC clients. Two flavours coexist in this table:
//
//  1. Per-server confidential clients (default). Federated Mumble servers
//     redirect their users through Oracle for sign-in; the row holds the
//     client_id + client_secret (plaintext high-entropy — oidc-provider
//     compares the wire value directly with no hash hook), and the allowed
//     redirect URIs.
//
//  2. Public first-party clients (isPublic = true, serverId IS NULL,
//     clientSecret empty). Used by the Hachiman desktop/browser apps for
//     end-user PKCE sign-in. PKCE is globally required in oidc-provider, so
//     a public client with token_endpoint_auth_method='none' is safe — the
//     code interception window is closed by the PKCE binding.
//
// serverId is unique-when-set so the per-server invariant still holds, while
// any number of public clients may exist with serverId IS NULL (Postgres
// treats NULLs as distinct under UNIQUE).
// ---------------------------------------------------------------------------
export const oidcClients = pgTable(
  'oidc_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // FK to the identity row. OIDC client survives re-homes (audience /
    // clientId in already-issued tokens stays valid).
    virtualServerId: uuid('virtual_server_id')
      .unique()
      .references(() => virtualServers.id, { onDelete: 'cascade' }),
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
// Invite codes — short alphanumeric codes a server owner can hand out;
// redeeming one returns a signed `takusen://join#...` URI.
// ---------------------------------------------------------------------------
export const inviteCodes = pgTable(
  'invite_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Invite is owned by IDENTITY: the redeemer's connection target comes
    // from the current placement row at redeem time, but the invite itself
    // survives a re-home.
    virtualServerId: uuid('virtual_server_id')
      .notNull()
      .references(() => virtualServers.id, { onDelete: 'cascade' }),
    code: text('code').notNull().unique(),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    maxUses: integer('max_uses'),
    useCount: integer('use_count').notNull().default(0),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
)

// ---------------------------------------------------------------------------
// User servers — a user's personal list of "joined" servers, used by the
// client UI as a sidebar/server list. May reference a registered Oracle
// server (serverId set), or carry raw host/port for unregistered servers the
// user joined manually.
// ---------------------------------------------------------------------------
export const userServers = pgTable(
  'user_servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // If this row refers to a registered Oracle server, set virtualServerId
    // (the identity row — survives re-homes). For unregistered (raw
    // host:port) servers the user joined manually, virtualServerId is null
    // and host/port/name carry the info.
    virtualServerId: uuid('virtual_server_id').references(() => virtualServers.id, {
      onDelete: 'set null',
    }),
    name: text('name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(64738),
    addedAt: timestamp('added_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('user_servers_user_host_port_unique').on(table.userId, table.host, table.port),
  ],
)

// ---------------------------------------------------------------------------
// Inferred row types — re-export for downstream consumers.
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Region = typeof regions.$inferSelect
export type NewRegion = typeof regions.$inferInsert
export type Server = typeof servers.$inferSelect
export type NewServer = typeof servers.$inferInsert
export type Island = typeof islands.$inferSelect
export type NewIsland = typeof islands.$inferInsert
export type IslandStatus = (typeof islandStatusEnum.enumValues)[number]
export type VirtualServer = typeof virtualServers.$inferSelect
export type NewVirtualServer = typeof virtualServers.$inferInsert
export type VirtualServerStatus = (typeof virtualServerStatusEnum.enumValues)[number]
export type ServerDomainVerification = typeof serverDomainVerifications.$inferSelect
export type OidcClient = typeof oidcClients.$inferSelect
export type InviteCode = typeof inviteCodes.$inferSelect
export type UserServer = typeof userServers.$inferSelect
export type NewUserServer = typeof userServers.$inferInsert

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
import { index } from 'drizzle-orm/pg-core'

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
// Per the MEDIA-PLANE-MIGRATION.md "Oracle owns placement and registry"
// decision, hachiman-media instances self-register with Oracle on boot and
// heartbeat liveness. The placement scorer reads this table when
// hachiman-control calls `PlaceMediaSession` (extension on management.proto;
// runtime wires in alongside phase 2 step 7).
//
// `capacity` is stored as jsonb so the descriptor can grow with the per-node
// resource model without a schema change (phase 1 stores `{cpu_cores, max_sessions}`;
// later passes add network egress caps, per-codec encode budgets, etc.).
//
// `status` is a free text column on the same enum-as-varchar pattern used in
// `channel.cascade_mode` on the control side — keeps drizzle migrations simple
// across SQLite dev shards while still letting placement scorers branch on a
// stable set ("active" | "draining" | "dead").
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
    // Single-tenant-per-node enforcement: stamped on the first PlaceMediaSession
    // call that lands a tenant on this node; cleared by the recovery sweeper
    // when activeSessions drops to 0. Phase 3a simplification — instead of a
    // separate active_sessions table tracking (node, tenant) tuples, we treat
    // a node as "owned" by the first tenant to land on it until it drains.
    // Null = unassigned / drained; an existing non-null value that doesn't
    // match the incoming tenant_id excludes the node from placement.
    tenantId: text('tenant_id'),
    // Sidechannel address control should dial to reach this node. Mirrored
    // from RegisterMediaNode payload; returned in PlaceMediaSession so
    // hachiman-control can stamp it into VoiceTokenGrant.media_node_addr.
    sidechannelAddr: text('sidechannel_addr').notNull().default(''),
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
