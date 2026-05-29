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
// Servers — registered Mumble servers in the Takusen registry.
// ---------------------------------------------------------------------------
export const servers = pgTable(
  'servers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: citext('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    host: text('host').notNull(),
    port: integer('port').notNull().default(64738),
    // When true, the server has opted in to Oracle-only authentication.
    // Informational from this layer's perspective: surfaced to clients via
    // the registry / introspection, and enforced by the Mumble server's own
    // OracleOnly configuration. Owner-toggleable from the dashboard.
    oracleOnly: boolean('oracle_only').notNull().default(false),
    // The server's currently-selected voice region. MUTABLE and re-selectable
    // (Discord-style): changing it is the future "re-home" trigger. Nullable
    // because legacy/un-placed servers have no region yet. ON DELETE SET NULL
    // so removing a region code never cascades into deleting servers.
    region: text('region').references(() => regions.code, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex('servers_slug_unique').on(table.slug)],
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
// Virtual servers — a MANAGED Mumble instance with a lifecycle, placed (or not
// yet placed) onto an island. This is the FUTURE "vServer" of the
// region→island→vServer model, now realized.
//
// KEY MODELING DECISION (1:1 with the registry): `serverId` is a UNIQUE FK to
// `servers.id`. A registry server is therefore EITHER
//   - self-hosted  → a `servers` row only (no virtual_servers row), or
//   - managed      → a `servers` row PLUS exactly one `virtual_servers` row.
// This extends the existing model without duplicating identity (slug, owner,
// host/port advertised to clients, OIDC client, invites, region all stay on
// `servers`); `virtual_servers` adds only the managed-placement/lifecycle facts.
// See ISLAND-PLATFORM.md for the alternatives that were rejected.
//
// `islandId` is NULLABLE = UNPLACED (the scheduler hasn't bin-packed it onto an
// island yet, or it has been drained off one). `region` is denormalized from
// the linked server's region so the scheduler can filter candidate islands by
// region without a join, and so an unplaced vServer still carries its target
// region. LIVE metrics are NOT stored here (Redis; see above).
// ---------------------------------------------------------------------------
export const virtualServers = pgTable('virtual_servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  // The registry server this managed instance backs. UNIQUE → strict 1:1.
  // ON DELETE CASCADE: deleting the registry server tears down its managed
  // placement row too (the runtime teardown is a separate, deferred concern).
  serverId: uuid('server_id')
    .notNull()
    .unique()
    .references(() => servers.id, { onDelete: 'cascade' }),
  status: virtualServerStatusEnum('status').notNull().default('inactive'),
  // Island placement. NULL = unplaced (awaiting/between scheduling). ON DELETE
  // SET NULL: if an island row is removed, its vServers become unplaced rather
  // than being deleted — the scheduler will re-home them.
  islandId: uuid('island_id').references(() => islands.id, { onDelete: 'set null' }),
  // The in-process vServer id WITHIN the island's Murmur process (Murmur's
  // numeric virtual-server id). NULL until placed/assigned on an island.
  murmurId: integer('murmur_id'),
  // The Mumble voice port this vServer is advertised/reachable on (via the
  // future HAProxy L4 port→island map). The client connects here.
  port: integer('port').notNull().default(64738),
  // Target voice region (denormalized from servers.region). NOT NULL: a managed
  // vServer is always placed-or-to-be-placed in a concrete region. ON DELETE
  // RESTRICT mirrors `islands.region`.
  region: text('region')
    .notNull()
    .references(() => regions.code, { onDelete: 'restrict' }),
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
  serverId: uuid('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),
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
    serverId: uuid('server_id')
      .unique()
      .references(() => servers.id, { onDelete: 'cascade' }),
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
    serverId: uuid('server_id')
      .notNull()
      .references(() => servers.id, { onDelete: 'cascade' }),
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
    // If this row refers to a registered Oracle server, set serverId.
    // For unregistered (raw host:port) servers the user joined manually,
    // serverId is null and host/port/name carry the info.
    serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
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
