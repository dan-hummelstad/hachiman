/**
 * Server registry CRUD.
 *
 * Owners create servers, which start unverified. A matching `oidcClients` row
 * is created at the same time — the OIDC agent owns the schema for that
 * table but registry creation is the only place rows get inserted.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  inviteCodes,
  oidcClients,
  serverDomainVerifications,
  servers,
  type Server,
} from '@/db/schema'

// Validation schemas live in a sibling module so client components can import
// them without dragging the postgres driver into the browser bundle.
export {
  slugSchema,
  createServerSchema,
  updateServerSchema,
  type CreateServerInput,
  type UpdateServerInput,
} from './server-schemas'
import { createServerSchema, updateServerSchema, type CreateServerInput, type UpdateServerInput } from './server-schemas'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SlugTakenError extends Error {
  constructor(slug: string) {
    super(`Slug "${slug}" is already taken`)
    this.name = 'SlugTakenError'
  }
}

export class ServerNotFoundError extends Error {
  constructor(idOrSlug: string) {
    super(`Server not found: ${idOrSlug}`)
    this.name = 'ServerNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// OIDC client secret helpers
// ---------------------------------------------------------------------------

function randomBase64Url(byteLength: number): string {
  const buf = new Uint8Array(byteLength)
  crypto.getRandomValues(buf)
  let str = ''
  for (const b of buf) str += String.fromCharCode(b)
  return Buffer.from(str, 'binary').toString('base64url')
}

function generateClientId(): string {
  // 16 bytes -> 22 char base64url; prefix for human recognisability.
  return `takusen_${randomBase64Url(16)}`
}

function generateClientSecret(): string {
  // 32 bytes of entropy.
  return randomBase64Url(32)
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PublicServerSummary {
  slug: string
  name: string
  description: string | null
  host: string
  port: number
  verifiedAt: Date | null
}

export interface ServerWithVerification extends Server {
  verifiedAt: Date | null
}

// ---------------------------------------------------------------------------
// Internal: latest-verification subquery (LATERAL) for "is verified" status.
// ---------------------------------------------------------------------------

function verifiedAtForServer(serverId: string) {
  // Returns the most-recent verifiedAt for this serverId across all
  // verification rows. NULL if never verified.
  return db
    .select({ verifiedAt: serverDomainVerifications.verifiedAt })
    .from(serverDomainVerifications)
    .where(
      and(
        eq(serverDomainVerifications.serverId, serverId),
        sql`${serverDomainVerifications.verifiedAt} IS NOT NULL`,
      ),
    )
    .orderBy(desc(serverDomainVerifications.verifiedAt))
    .limit(1)
}

async function attachVerifiedAt(server: Server): Promise<ServerWithVerification> {
  const rows = await verifiedAtForServer(server.id)
  return { ...server, verifiedAt: rows[0]?.verifiedAt ?? null }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface CreateServerResult {
  server: Server
  oidcClientId: string
  /** Plain-text secret. Returned once, never persisted as plaintext. */
  oidcClientSecret: string
}

export async function createServer(
  input: CreateServerInput,
): Promise<CreateServerResult> {
  const parsed = createServerSchema.parse(input)

  // Check slug uniqueness up-front to give a friendlier error than the DB.
  const existing = await db
    .select({ id: servers.id })
    .from(servers)
    .where(eq(servers.slug, parsed.slug))
    .limit(1)
  if (existing.length > 0) {
    throw new SlugTakenError(parsed.slug)
  }

  const clientId = generateClientId()
  const clientSecret = generateClientSecret()

  return await db.transaction(async (tx) => {
    const insertedServers = await tx
      .insert(servers)
      .values({
        ownerUserId: input.ownerUserId,
        name: parsed.name,
        slug: parsed.slug,
        host: parsed.host,
        port: parsed.port ?? 64738,
        description: parsed.description ?? null,
      })
      .returning()
    const server = insertedServers[0]
    if (!server) {
      throw new Error('Failed to insert server')
    }

    await tx.insert(oidcClients).values({
      serverId: server.id,
      clientId,
      clientSecret,
      redirectUris: [],
    })

    return { server, oidcClientId: clientId, oidcClientSecret: clientSecret }
  })
}

export async function getServerById(
  id: string,
): Promise<ServerWithVerification | null> {
  const rows = await db.select().from(servers).where(eq(servers.id, id)).limit(1)
  const server = rows[0]
  if (!server) return null
  return attachVerifiedAt(server)
}

export async function getServerBySlug(
  slug: string,
): Promise<ServerWithVerification | null> {
  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.slug, slug))
    .limit(1)
  const server = rows[0]
  if (!server) return null
  return attachVerifiedAt(server)
}

export async function listServersByOwner(
  ownerUserId: string,
): Promise<ServerWithVerification[]> {
  const rows = await db
    .select()
    .from(servers)
    .where(eq(servers.ownerUserId, ownerUserId))
    .orderBy(asc(servers.name))

  return Promise.all(rows.map(attachVerifiedAt))
}

export async function updateServer(
  id: string,
  patch: UpdateServerInput,
): Promise<Server> {
  const parsed = updateServerSchema.parse(patch)
  const updates: Partial<typeof servers.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (parsed.name !== undefined) updates.name = parsed.name
  if (parsed.description !== undefined) updates.description = parsed.description

  const rows = await db
    .update(servers)
    .set(updates)
    .where(eq(servers.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new ServerNotFoundError(id)
  return row
}

export async function deleteServer(id: string): Promise<void> {
  const rows = await db.delete(servers).where(eq(servers.id, id)).returning({
    id: servers.id,
  })
  if (rows.length === 0) {
    throw new ServerNotFoundError(id)
  }
}

// ---------------------------------------------------------------------------
// Public listing (verified servers only)
// ---------------------------------------------------------------------------

export interface ListPublicServersOptions {
  search?: string
  limit?: number
  offset?: number
}

export interface ListPublicServersResult {
  servers: PublicServerSummary[]
  total: number
}

export async function listPublicServers(
  options: ListPublicServersOptions = {},
): Promise<ListPublicServersResult> {
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
  const offset = Math.max(options.offset ?? 0, 0)
  const search = options.search?.trim() ?? ''

  // "Verified" = at least one verification row with verifiedAt IS NOT NULL.
  const verifiedFilter = sql`EXISTS (
    SELECT 1 FROM ${serverDomainVerifications} sdv
    WHERE sdv.server_id = ${servers.id}
      AND sdv.verified_at IS NOT NULL
  )`

  const searchFilter = search
    ? or(ilike(servers.name, `%${search}%`), eq(servers.slug, search.toLowerCase()))
    : undefined

  const where = searchFilter ? and(verifiedFilter, searchFilter) : verifiedFilter

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        slug: servers.slug,
        name: servers.name,
        description: servers.description,
        host: servers.host,
        port: servers.port,
        serverId: servers.id,
      })
      .from(servers)
      .where(where)
      .orderBy(asc(servers.name))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(servers)
      .where(where),
  ])

  const results: PublicServerSummary[] = await Promise.all(
    rows.map(async (r) => {
      const v = await verifiedAtForServer(r.serverId)
      return {
        slug: r.slug,
        name: r.name,
        description: r.description,
        host: r.host,
        port: r.port,
        verifiedAt: v[0]?.verifiedAt ?? null,
      }
    }),
  )

  return {
    servers: results,
    total: totalRows[0]?.count ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Ownership helper
// ---------------------------------------------------------------------------

export async function assertOwner(serverId: string, userId: string): Promise<Server> {
  const rows = await db
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.ownerUserId, userId)))
    .limit(1)
  const server = rows[0]
  if (!server) {
    throw new ServerNotFoundError(serverId)
  }
  return server
}

// ---------------------------------------------------------------------------
// Invite listing (used by /servers/[id] detail page)
// ---------------------------------------------------------------------------

export async function listInvitesForServer(serverId: string) {
  return await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.serverId, serverId))
    .orderBy(desc(inviteCodes.createdAt))
}
