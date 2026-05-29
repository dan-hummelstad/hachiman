/**
 * Virtual-server control-plane CRUD + lifecycle state machine.
 *
 * A "virtual server" is a MANAGED Mumble instance (1:1 with a registry
 * `servers` row via the unique `serverId` FK — see schema.ts / the modeling
 * decision in ISLAND-PLATFORM.md) that the scheduler places onto an island and
 * that moves through a fixed lifecycle:
 *
 *     inactive → starting → active → cooling → inactive
 *
 * `transitionVServer` is the single guarded write for `status`: it validates
 * the requested transition against `VSERVER_TRANSITIONS` and rejects illegal
 * jumps (e.g. inactive → active, or active → starting). Placement (`islandId`)
 * is a separate concern handled by `placeVServer` / `unplaceVServer`.
 */
import { asc, eq } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  virtualServers,
  type NewVirtualServer,
  type VirtualServer,
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
//
//   inactive → starting → active → cooling → inactive
//
// Each state lists the states it may move to. The cycle is intentionally
// one-directional; there are no skip-ahead or rewind edges. A no-op transition
// (X → X) is rejected as well — callers should not churn the row for nothing.
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
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateVServerInput {
  serverId: string
  region: string
  status?: VirtualServerStatus
  islandId?: string | null
  murmurId?: number | null
  port?: number
  maxUsers?: number
  maxBandwidth?: number
}

export interface UpdateVServerInput {
  region?: string
  murmurId?: number | null
  port?: number
  maxUsers?: number
  maxBandwidth?: number
  lastActiveAt?: Date | null
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Create a managed vServer backing a registry server. NOTE: `region` is
 * denormalized from the backing `servers.region` — the caller must pass the
 * server's region, and the future re-home flow must keep the two in sync (the
 * FK to `regions` guarantees validity, not agreement with the server's region).
 */
export async function createVServer(input: CreateVServerInput): Promise<VirtualServer> {
  const values: NewVirtualServer = {
    serverId: input.serverId,
    region: input.region,
  }
  if (input.status !== undefined) values.status = input.status
  if (input.islandId !== undefined) values.islandId = input.islandId
  if (input.murmurId !== undefined) values.murmurId = input.murmurId
  if (input.port !== undefined) values.port = input.port
  if (input.maxUsers !== undefined) values.maxUsers = input.maxUsers
  if (input.maxBandwidth !== undefined) values.maxBandwidth = input.maxBandwidth

  const rows = await db.insert(virtualServers).values(values).returning()
  const row = rows[0]
  if (!row) throw new Error('Failed to insert virtual server')
  return row
}

export async function getVServerById(id: string): Promise<VirtualServer | null> {
  const rows = await db
    .select()
    .from(virtualServers)
    .where(eq(virtualServers.id, id))
    .limit(1)
  return rows[0] ?? null
}

export async function getVServerByServerId(
  serverId: string,
): Promise<VirtualServer | null> {
  const rows = await db
    .select()
    .from(virtualServers)
    .where(eq(virtualServers.serverId, serverId))
    .limit(1)
  return rows[0] ?? null
}

/** All managed vServers, ordered by region then creation. */
export async function listVServers(): Promise<VirtualServer[]> {
  return await db
    .select()
    .from(virtualServers)
    .orderBy(asc(virtualServers.region), asc(virtualServers.createdAt))
}

/** Managed vServers placed on a given island. */
export async function listVServersByIsland(islandId: string): Promise<VirtualServer[]> {
  return await db
    .select()
    .from(virtualServers)
    .where(eq(virtualServers.islandId, islandId))
    .orderBy(asc(virtualServers.createdAt))
}

/**
 * Update non-lifecycle, non-placement fields. `status` is deliberately NOT
 * accepted here — it only moves through `transitionVServer`.
 */
export async function updateVServer(
  id: string,
  patch: UpdateVServerInput,
): Promise<VirtualServer> {
  const updates: Partial<NewVirtualServer> = { updatedAt: new Date() }
  if (patch.region !== undefined) updates.region = patch.region
  if (patch.murmurId !== undefined) updates.murmurId = patch.murmurId
  if (patch.port !== undefined) updates.port = patch.port
  if (patch.maxUsers !== undefined) updates.maxUsers = patch.maxUsers
  if (patch.maxBandwidth !== undefined) updates.maxBandwidth = patch.maxBandwidth
  if (patch.lastActiveAt !== undefined) updates.lastActiveAt = patch.lastActiveAt

  const rows = await db
    .update(virtualServers)
    .set(updates)
    .where(eq(virtualServers.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new VirtualServerNotFoundError(id)
  return row
}

export async function deleteVServer(id: string): Promise<void> {
  const rows = await db
    .delete(virtualServers)
    .where(eq(virtualServers.id, id))
    .returning({ id: virtualServers.id })
  if (rows.length === 0) throw new VirtualServerNotFoundError(id)
}

// ---------------------------------------------------------------------------
// Placement (the scheduler's write surface). Intended sequence:
//   place → transitionVServer('starting') → 'active' … 'cooling' → unplace.
// To keep `status` and `islandId` coherent (never "active but nowhere"),
// `unplaceVServer` and `deleteIsland` reset affected vServers to `inactive`.
// `placeVServer` only assigns the island; the scheduler then drives the
// lifecycle via `transitionVServer`.
// ---------------------------------------------------------------------------

/** Bind a vServer to an island (the bin-packing scheduler's output). */
export async function placeVServer(
  id: string,
  islandId: string,
): Promise<VirtualServer> {
  const rows = await db
    .update(virtualServers)
    .set({ islandId, updatedAt: new Date() })
    .where(eq(virtualServers.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new VirtualServerNotFoundError(id)
  return row
}

/**
 * Detach a vServer from its island (drained / re-home). An unplaced vServer
 * isn't running anywhere, so this also resets its lifecycle to `inactive`,
 * keeping `status` and `islandId` coherent (never "active but nowhere").
 */
export async function unplaceVServer(id: string): Promise<VirtualServer> {
  const rows = await db
    .update(virtualServers)
    .set({ islandId: null, status: 'inactive', updatedAt: new Date() })
    .where(eq(virtualServers.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new VirtualServerNotFoundError(id)
  return row
}

// ---------------------------------------------------------------------------
// Lifecycle transition — the SINGLE guarded `status` write.
// ---------------------------------------------------------------------------

/**
 * Move a vServer to a new lifecycle state, enforcing the valid transitions.
 * Throws `InvalidVServerTransitionError` on an illegal jump (including X → X)
 * and `VirtualServerNotFoundError` if the row doesn't exist. On the
 * cooling/active edges we also stamp `lastActiveAt` so the cooling sweep has a
 * timestamp to age against.
 */
export async function transitionVServer(
  id: string,
  to: VirtualServerStatus,
): Promise<VirtualServer> {
  const current = await getVServerById(id)
  if (!current) throw new VirtualServerNotFoundError(id)

  if (!canTransitionVServer(current.status, to)) {
    throw new InvalidVServerTransitionError(current.status, to)
  }

  const updates: Partial<NewVirtualServer> = { status: to, updatedAt: new Date() }
  // Becoming active or beginning to cool are both "activity" boundaries worth
  // timestamping for the cooling→inactive aging sweep.
  if (to === 'active' || to === 'cooling') {
    updates.lastActiveAt = new Date()
  }

  const rows = await db
    .update(virtualServers)
    .set(updates)
    .where(eq(virtualServers.id, id))
    .returning()
  const row = rows[0]
  if (!row) throw new VirtualServerNotFoundError(id)
  return row
}
