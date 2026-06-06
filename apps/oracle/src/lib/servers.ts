/**
 * Server registry CRUD.
 *
 * "Server" is the user-facing concept; physically it's split between two
 * tables (see schema.ts):
 *   - `virtual_servers` (identity) — id, owner, slug, name, description,
 *     region, oracleOnly. STABLE across re-homes; every FK from invites,
 *     OIDC clients, and domain verifications points HERE.
 *   - `servers` (placement) — host, port, islandId, murmurId, status,
 *     capacity caps, lastActiveAt. Mutates when a vServer is placed,
 *     re-homed, or its lifecycle advances.
 *
 * This module's PUBLIC surface (the `Server` type, `createServer`,
 * `updateServer`, `getServerById`, …) pretends the two tables are one — it
 * joins them on every read and writes both atomically. The `id` exposed
 * to callers is `virtual_servers.id` (the external identity); the
 * placement row's own id is internal-only. Lifecycle / placement writes
 * (place/unplace/transition) live in `lib/virtual-servers.ts`.
 */
import { and, asc, desc, eq, ilike, or, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  inviteCodes,
  oidcClients,
  regions,
  serverDomainVerifications,
  servers as placements,
  virtualServers,
  type Region,
  type Server as Placement,
  type VirtualServer,
  type VirtualServerStatus,
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
import {
  createServerSchema,
  updateServerSchema,
  type CreateServerInput,
  type UpdateServerInput,
} from './server-schemas'

// Managed-host stamping lives in a DB-free sibling so the unit test can run
// without importing the postgres-js pool.
import { resolveServerEndpoint } from './managed-host'
export { ManagedGatewayNotConfiguredError } from './managed-host'

// The gRPC client to the managed-gateway Grumble process. Only the managed
// branch of createServer + deleteServer call it.
import {
  createVirtualServer as createGrumbleVirtualServer,
  deleteVirtualServer as deleteGrumbleVirtualServer,
  GrumbleManagementError,
} from './grumble-management'

// ---------------------------------------------------------------------------
// Managed-server introspection URL.
// ---------------------------------------------------------------------------

const INTROSPECTION_PATH = '/token/introspection'

function getIntrospectionUrl(): string {
  const issuer = process.env.OIDC_ISSUER_URL?.trim() || 'http://localhost:3000/api/oidc'
  return `${issuer.replace(/\/+$/, '')}${INTROSPECTION_PATH}`
}

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
// Public types — the unified Server shape callers see.
// ---------------------------------------------------------------------------

/**
 * The unified "Server" shape exposed by this module. Identity fields come
 * from `virtual_servers`; placement fields come from `servers`. The `id`
 * is the identity id — that's the value invites/OIDC/verifications/the
 * dashboard URL all key off.
 *
 * `host`/`port`/`status`/`islandId`/`murmurId`/`maxUsers`/`maxBandwidth`/
 * `lastActiveAt` can be NULL for a freshly-created identity row whose
 * placement row was created concurrently in the same tx (impossible in
 * practice — both inserts share a transaction — but the LEFT JOIN
 * widening forces these to be optional in the type). Callers should
 * treat their presence as "always set for any server returned by this
 * module" and the nullability as a type-system artifact.
 */
export interface Server {
  id: string
  ownerUserId: string
  slug: string
  name: string
  description: string | null
  oracleOnly: boolean
  region: string | null
  host: string
  port: number
  islandId: string | null
  murmurId: number | null
  status: VirtualServerStatus
  maxUsers: number
  maxBandwidth: number
  lastActiveAt: Date | null
  createdAt: Date
  updatedAt: Date
}

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
// Internal helpers
// ---------------------------------------------------------------------------

const POSTGRES_UNIQUE_VIOLATION = '23505'

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === POSTGRES_UNIQUE_VIOLATION
  )
}

function normalizeDescription(d: string | null | undefined): string | null {
  if (d == null) return null
  const trimmed = d.trim()
  return trimmed === '' ? null : trimmed
}

function randomBase64Url(byteLength: number): string {
  const buf = new Uint8Array(byteLength)
  crypto.getRandomValues(buf)
  let str = ''
  for (const b of buf) str += String.fromCharCode(b)
  return Buffer.from(str, 'binary').toString('base64url')
}

function generateClientId(): string {
  return `takusen_${randomBase64Url(16)}`
}

function generateClientSecret(): string {
  return randomBase64Url(32)
}

/**
 * Project the (virtual_servers + servers) join into the unified Server
 * shape. NULL fields from the LEFT JOIN are folded back to schema
 * defaults so callers see a stable Server object regardless of the
 * (impossible-in-practice) "identity row exists, placement row missing"
 * state.
 */
function projectJoined(
  v: VirtualServer,
  p: Placement | null,
): Server {
  return {
    id: v.id,
    ownerUserId: v.ownerUserId,
    slug: v.slug,
    name: v.name,
    description: v.description,
    oracleOnly: v.oracleOnly,
    region: v.region,
    host: p?.host ?? '',
    port: p?.port ?? 64738,
    islandId: p?.islandId ?? null,
    murmurId: p?.murmurId ?? null,
    status: p?.status ?? 'inactive',
    maxUsers: p?.maxUsers ?? 100,
    maxBandwidth: p?.maxBandwidth ?? 558000,
    lastActiveAt: p?.lastActiveAt ?? null,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

/** Internal: LEFT JOIN the placement row onto an identity row. */
async function loadOne(
  where: (typeof virtualServers)['id']['_']['data'] extends never
    ? never
    : Parameters<typeof eq>[1] | ReturnType<typeof and>,
): Promise<Server | null> {
  // Drizzle's join return shape is `{ virtual_servers: VirtualServer; servers: Placement | null }`.
  const rows = await db
    .select()
    .from(virtualServers)
    .leftJoin(placements, eq(placements.virtualServerId, virtualServers.id))
    .where(where as never)
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return projectJoined(row.virtual_servers, row.servers)
}

// ---------------------------------------------------------------------------
// Verification subquery (latest-verifiedAt).
// ---------------------------------------------------------------------------

function verifiedAtForServer(virtualServerId: string) {
  return db
    .select({ verifiedAt: serverDomainVerifications.verifiedAt })
    .from(serverDomainVerifications)
    .where(
      and(
        eq(serverDomainVerifications.virtualServerId, virtualServerId),
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

export async function createServer(input: CreateServerInput): Promise<CreateServerResult> {
  const parsed = createServerSchema.parse(input)

  // Decide the final host:port pair BEFORE the DB transaction. Throws
  // ManagedGatewayNotConfiguredError on the managed branch when env unset.
  const { host, port } = resolveServerEndpoint(parsed)

  const clientId = generateClientId()
  const clientSecret = generateClientSecret()

  return await db.transaction(async (tx) => {
    // Identity row first (unique slug lives here now). Catch unique
    // violations and translate to SlugTakenError.
    let identityRows: VirtualServer[]
    try {
      identityRows = await tx
        .insert(virtualServers)
        .values({
          ownerUserId: input.ownerUserId,
          name: parsed.name,
          slug: parsed.slug,
          description: normalizeDescription(parsed.description),
          region: parsed.region ?? null,
        })
        .returning()
    } catch (err) {
      if (isUniqueViolation(err)) throw new SlugTakenError(parsed.slug)
      throw err
    }
    const identity = identityRows[0]
    if (!identity) throw new Error('Failed to insert virtual_server (identity)')

    // Placement row — always exactly one (1:1, self-hosted gets islandId=null).
    const placementRows = await tx
      .insert(placements)
      .values({
        virtualServerId: identity.id,
        host,
        port,
        // murmurId stays null until set by the gRPC create below (managed
        // branch) or until a future placement scheduler assigns one.
      })
      .returning()
    const placement = placementRows[0]
    if (!placement) throw new Error('Failed to insert servers (placement)')

    // OIDC client FKs to identity (survives re-home).
    await tx.insert(oidcClients).values({
      virtualServerId: identity.id,
      clientId,
      clientSecret,
      redirectUris: [],
    })

    // Managed branch: provision the in-process vServer on the gateway and
    // stash the resulting murmurId + actual listening port on the placement
    // row. Held INSIDE the transaction so a gRPC failure rolls back all
    // four inserts.
    //
    // Why the port update: Grumble derives the listening port from the
    // vServer id (default 64738 + id - 1) — the initial placement insert
    // landed with the `MANAGED_SERVER_PORT` placeholder, which would
    // misadvertise the address for the 2nd+ vServer. The gRPC response
    // carries the real port so we persist what Grumble actually opened.
    if (parsed.mode === 'managed') {
      const result = await createGrumbleVirtualServer({
        adminOracleUserId: input.ownerUserId,
        oracleIntrospectionUrl: getIntrospectionUrl(),
        oracleClientId: clientId,
        oracleClientSecret: clientSecret,
      })
      await tx
        .update(placements)
        .set({
          murmurId: result.serverId,
          port: result.port,
          updatedAt: new Date(),
        })
        .where(eq(placements.id, placement.id))
      placement.murmurId = result.serverId
      placement.port = result.port
      console.info(
        `[managed] Grumble provisioned vServer id=${result.serverId} on ` +
          `port ${result.port} for oracle server ${identity.id} ` +
          `(slug=${identity.slug}, owner=${input.ownerUserId})`,
      )
    }

    return {
      server: projectJoined(identity, placement),
      oidcClientId: clientId,
      oidcClientSecret: clientSecret,
    }
  })
}

export async function getServerById(id: string): Promise<ServerWithVerification | null> {
  const server = await loadOne(eq(virtualServers.id, id))
  if (!server) return null
  return attachVerifiedAt(server)
}

export async function getServerBySlug(slug: string): Promise<ServerWithVerification | null> {
  const server = await loadOne(eq(virtualServers.slug, slug))
  if (!server) return null
  return attachVerifiedAt(server)
}

export async function listServersByOwner(
  ownerUserId: string,
): Promise<ServerWithVerification[]> {
  const rows = await db
    .select()
    .from(virtualServers)
    .leftJoin(placements, eq(placements.virtualServerId, virtualServers.id))
    .where(eq(virtualServers.ownerUserId, ownerUserId))
    .orderBy(asc(virtualServers.name))
  const projected = rows.map((r) => projectJoined(r.virtual_servers, r.servers))
  return Promise.all(projected.map(attachVerifiedAt))
}

export async function updateServer(id: string, patch: UpdateServerInput): Promise<Server> {
  const parsed = updateServerSchema.parse(patch)

  // All four updatable fields live on virtual_servers (identity). Placement
  // updates have their own helpers in lib/virtual-servers.ts.
  const updates: Partial<typeof virtualServers.$inferInsert> = {
    updatedAt: new Date(),
  }
  if (parsed.name !== undefined) updates.name = parsed.name
  if (parsed.description !== undefined)
    updates.description = normalizeDescription(parsed.description)
  if (parsed.oracleOnly !== undefined) updates.oracleOnly = parsed.oracleOnly
  if (parsed.region !== undefined) updates.region = parsed.region

  const rows = await db
    .update(virtualServers)
    .set(updates)
    .where(eq(virtualServers.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new ServerNotFoundError(id)

  // Re-load the joined view so callers get host/port back too.
  const reloaded = await loadOne(eq(virtualServers.id, id))
  if (!reloaded) throw new ServerNotFoundError(id)
  return reloaded
}

export async function listRegions(): Promise<Region[]> {
  return await db.select().from(regions).orderBy(asc(regions.displayName))
}

export async function deleteServer(id: string): Promise<void> {
  // Look up the placement's murmurId BEFORE the cascade — once we delete
  // the identity row, the placement row goes with it (ON DELETE CASCADE).
  const pRows = await db
    .select({ murmurId: placements.murmurId })
    .from(placements)
    .where(eq(placements.virtualServerId, id))
    .limit(1)
  const murmurId = pRows[0]?.murmurId ?? null

  // Cascade: deleting virtual_servers takes servers + oidc_clients +
  // invite_codes + server_domain_verifications with it.
  const rows = await db
    .delete(virtualServers)
    .where(eq(virtualServers.id, id))
    .returning({ id: virtualServers.id })
  if (rows.length === 0) {
    throw new ServerNotFoundError(id)
  }

  // Best-effort gateway teardown for managed servers. murmurId === null =
  // self-hosted (or pre-managed-create), skip.
  if (murmurId !== null) {
    try {
      await deleteGrumbleVirtualServer({ serverId: murmurId })
    } catch (err) {
      if (err instanceof GrumbleManagementError) {
        console.warn(
          `[managed] DeleteVirtualServer best-effort teardown failed for ` +
            `murmurId=${murmurId} (oracle server ${id}): ${err.message}. ` +
            `The Oracle-side delete succeeded; the gateway vServer may be orphaned.`,
        )
      } else {
        throw err
      }
    }
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
  // FK now points at virtual_servers.id (identity).
  const verifiedFilter = sql`EXISTS (
    SELECT 1 FROM ${serverDomainVerifications} sdv
    WHERE sdv.virtual_server_id = ${virtualServers.id}
      AND sdv.verified_at IS NOT NULL
  )`

  const searchFilter = search
    ? or(
        ilike(virtualServers.name, `%${search}%`),
        eq(virtualServers.slug, search.toLowerCase()),
      )
    : undefined

  const where = searchFilter ? and(verifiedFilter, searchFilter) : verifiedFilter

  const [rows, totalRows] = await Promise.all([
    db
      .select({
        slug: virtualServers.slug,
        name: virtualServers.name,
        description: virtualServers.description,
        host: placements.host,
        port: placements.port,
        virtualServerId: virtualServers.id,
      })
      .from(virtualServers)
      .leftJoin(placements, eq(placements.virtualServerId, virtualServers.id))
      .where(where)
      .orderBy(asc(virtualServers.name))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(virtualServers)
      .where(where),
  ])

  const results: PublicServerSummary[] = await Promise.all(
    rows.map(async (r) => {
      const v = await verifiedAtForServer(r.virtualServerId)
      return {
        slug: r.slug,
        name: r.name,
        description: r.description,
        host: r.host ?? '',
        port: r.port ?? 64738,
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
  const server = await loadOne(
    and(eq(virtualServers.id, serverId), eq(virtualServers.ownerUserId, userId)),
  )
  if (!server) {
    throw new ServerNotFoundError(serverId)
  }
  return server
}

// ---------------------------------------------------------------------------
// Invite listing (used by /servers/[id] detail page).
// ---------------------------------------------------------------------------

export async function listInvitesForServer(virtualServerId: string) {
  return await db
    .select()
    .from(inviteCodes)
    .where(eq(inviteCodes.virtualServerId, virtualServerId))
    .orderBy(desc(inviteCodes.createdAt))
}
