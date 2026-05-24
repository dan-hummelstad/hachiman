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
// OIDC clients — one per server. Servers redirect their users through Oracle
// for sign-in; this row holds the client_id, client_secret (stored as a
// plaintext high-entropy string — oidc-provider compares the wire value
// against this field directly and has no hook for hash comparison), and the
// allowed redirect URIs.
// ---------------------------------------------------------------------------
export const oidcClients = pgTable(
  'oidc_clients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    serverId: uuid('server_id')
      .notNull()
      .unique()
      .references(() => servers.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().unique(),
    clientSecret: text('client_secret').notNull(),
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
// Inferred row types — re-export for downstream consumers.
// ---------------------------------------------------------------------------
export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert
export type Server = typeof servers.$inferSelect
export type NewServer = typeof servers.$inferInsert
export type ServerDomainVerification = typeof serverDomainVerifications.$inferSelect
export type OidcClient = typeof oidcClients.$inferSelect
export type InviteCode = typeof inviteCodes.$inferSelect

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
