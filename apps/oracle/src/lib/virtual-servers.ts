/**
 * Virtual-server placement + lifecycle state machine.
 *
 * A "virtual server" is the IDENTITY (`virtual_servers` row). Its companion
 * `servers` row carries the PLACEMENT — islandId, murmurId, host/port,
 * lifecycle status, capacity. Identity → placement is 1:1 via the unique
 * `servers.virtualServerId` FK.
 *
 * Every function in this module takes a `vsId` argument that is the
 * IDENTITY id (`virtual_servers.id`) — the same id callers use everywhere
 * else (invites, OIDC, dashboard URLs). Internally we resolve through the
 * placement row to update the lifecycle fields.
 *
 *     inactive → starting → active → cooling → inactive
 *
 * `transitionVServer` is the single guarded write for `status`: it
 * validates the requested transition against `VSERVER_TRANSITIONS` and
 * rejects illegal jumps. Placement (`islandId`) is handled by
 * `placeVServer` / `unplaceVServer`.
 */
import { asc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  servers as placements,
  virtualServers,
  type Server as Placement,
  type VirtualServerStatus,
} from '@/db/schema'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class VirtualServerNotFoundError extends Error {
  constructor(id: string) {
    super(`Virtual server not found: ${id}`)
    this.name = 'VirtualServerNotFoundError'
  }
}

export class InvalidVServerTransitionError extends Error {
  constructor(
    public readonly from: VirtualServerStatus,
    public readonly to: VirtualServerStatus,
  ) {
    super(`Invalid virtual-server lifecycle transition: ${from} → ${to}`)
    this.name = 'InvalidVServerTransitionError'
  }
}

// ---------------------------------------------------------------------------
// Lifecycle state machine (authoritative).
// ---------------------------------------------------------------------------

export const VSERVER_TRANSITIONS: Readonly<
  Record<VirtualServerStatus, ReadonlyArray<VirtualServerStatus>>
> = {
  inactive: ['starting'],
  starting: ['active'],
  active: ['cooling'],
  cooling: ['inactive'],
}

export function canTransitionVServer(
  from: VirtualServerStatus,
  to: VirtualServerStatus,
): boolean {
  return VSERVER_TRANSITIONS[from].includes(to)
}

// ---------------------------------------------------------------------------
// Read view — a joined identity+placement projection with the fields the
// scheduler + admin actions care about. `id` here is the IDENTITY id (the
// same id callers use everywhere else).
// ---------------------------------------------------------------------------

export interface VServerView {
  /** Identity id (virtual_servers.id). External identifier used by every caller. */
  id: string
  /** Owner-selected region — sourced from the IDENTITY row. */
  region: string | null
  status: VirtualServerStatus
  islandId: string | null
  murmurId: number | null
  port: number
  maxUsers: number
  maxBandwidth: number
  lastActiveAt: Date | null
  /** Identity-row creation timestamp. */
  createdAt: Date
}

function projectView(
  vs: { id: string; region: string | null; createdAt: Date },
  p: Placement,
): VServerView {
  return {
    id: vs.id,
    region: vs.region,
    status: p.status,
    islandId: p.islandId,
    murmurId: p.murmurId,
    port: p.port,
    maxUsers: p.maxUsers,
    maxBandwidth: p.maxBandwidth,
    lastActiveAt: p.lastActiveAt,
    createdAt: vs.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getVServerById(id: string): Promise<VServerView | null> {
  const rows = await db
    .select({
      vsId: virtualServers.id,
      vsRegion: virtualServers.region,
      vsCreatedAt: virtualServers.createdAt,
      placement: placements,
    })
    .from(virtualServers)
    .innerJoin(placements, eq(placements.virtualServerId, virtualServers.id))
    .where(eq(virtualServers.id, id))
    .limit(1)
  const row = rows[0]
  if (!row) return null
  return projectView(
    { id: row.vsId, region: row.vsRegion, createdAt: row.vsCreatedAt },
    row.placement,
  )
}

/** All managed vServers, ordered by identity region then identity createdAt. */
export async function listVServers(): Promise<VServerView[]> {
  const rows = await db
    .select({
      vsId: virtualServers.id,
      vsRegion: virtualServers.region,
      vsCreatedAt: virtualServers.createdAt,
      placement: placements,
    })
    .from(virtualServers)
    .innerJoin(placements, eq(placements.virtualServerId, virtualServers.id))
    .orderBy(asc(virtualServers.region), asc(virtualServers.createdAt))
  return rows.map((r) =>
    projectView({ id: r.vsId, region: r.vsRegion, createdAt: r.vsCreatedAt }, r.placement),
  )
}

/** Placements assigned to a given island (joined for the identity-side view). */
export async function listVServersByIsland(islandId: string): Promise<VServerView[]> {
  const rows = await db
    .select({
      vsId: virtualServers.id,
      vsRegion: virtualServers.region,
      vsCreatedAt: virtualServers.createdAt,
      placement: placements,
    })
    .from(virtualServers)
    .innerJoin(placements, eq(placements.virtualServerId, virtualServers.id))
    .where(eq(placements.islandId, islandId))
    .orderBy(asc(virtualServers.createdAt))
  return rows.map((r) =>
    projectView({ id: r.vsId, region: r.vsRegion, createdAt: r.vsCreatedAt }, r.placement),
  )
}

// ---------------------------------------------------------------------------
// Placement writes — operate on the `servers` (placement) row by joining
// from the identity id the caller supplies.
// ---------------------------------------------------------------------------

/** Bind a vServer to an island (the bin-packing scheduler's output). */
export async function placeVServer(id: string, islandId: string): Promise<VServerView> {
  const rows = await db
    .update(placements)
    .set({ islandId, updatedAt: new Date() })
    .where(eq(placements.virtualServerId, id))
    .returning()
  const placement = rows[0]
  if (!placement) throw new VirtualServerNotFoundError(id)
  const view = await getVServerById(id)
  if (!view) throw new VirtualServerNotFoundError(id)
  return view
}

/**
 * Detach a vServer from its island (drained / re-home). Also resets its
 * lifecycle to `inactive` so we never end up "active but nowhere".
 */
export async function unplaceVServer(id: string): Promise<VServerView> {
  const rows = await db
    .update(placements)
    .set({ islandId: null, status: 'inactive', updatedAt: new Date() })
    .where(eq(placements.virtualServerId, id))
    .returning()
  const placement = rows[0]
  if (!placement) throw new VirtualServerNotFoundError(id)
  const view = await getVServerById(id)
  if (!view) throw new VirtualServerNotFoundError(id)
  return view
}

// ---------------------------------------------------------------------------
// Lifecycle transition — the SINGLE guarded `status` write.
// ---------------------------------------------------------------------------

export async function transitionVServer(
  id: string,
  to: VirtualServerStatus,
): Promise<VServerView> {
  const current = await getVServerById(id)
  if (!current) throw new VirtualServerNotFoundError(id)

  if (!canTransitionVServer(current.status, to)) {
    throw new InvalidVServerTransitionError(current.status, to)
  }

  const updates: Partial<typeof placements.$inferInsert> = {
    status: to,
    updatedAt: new Date(),
  }
  if (to === 'active' || to === 'cooling') {
    updates.lastActiveAt = new Date()
  }

  const rows = await db
    .update(placements)
    .set(updates)
    .where(eq(placements.virtualServerId, id))
    .returning()
  if (rows.length === 0) throw new VirtualServerNotFoundError(id)
  const view = await getVServerById(id)
  if (!view) throw new VirtualServerNotFoundError(id)
  return view
}
