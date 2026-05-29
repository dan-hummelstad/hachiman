/**
 * Islands control-plane CRUD.
 *
 * An "island" is one Murmur process (one k3s pod, deferred runtime) that hosts
 * many in-process virtual servers, living inside a region. This module owns the
 * durable control-plane row only; LIVE island metrics (active users, CPU,
 * bandwidth) are NOT stored here — they live in Redis and are handed to the
 * bin-packing scheduler at scoring time (see ISLAND-PLATFORM.md).
 *
 * Pure DB access; no scheduler logic. The scheduler (next team) consumes
 * `listIslands` + `countVServersByIsland` + Redis metrics to score placement.
 */
import { asc, eq, isNull, sql } from 'drizzle-orm'

import { db } from '@/db/client'
import {
  islands,
  virtualServers,
  type Island,
  type IslandStatus,
  type NewIsland,
  type VirtualServer,
} from '@/db/schema'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class IslandNotFoundError extends Error {
  constructor(id: string) {
    super(`Island not found: ${id}`)
    this.name = 'IslandNotFoundError'
  }
}

// ---------------------------------------------------------------------------
// Input shapes
// ---------------------------------------------------------------------------

export interface CreateIslandInput {
  host: string
  grpcPort: number
  region: string
  status?: IslandStatus
  maxVservers?: number
}

export interface UpdateIslandInput {
  host?: string
  grpcPort?: number
  region?: string
  status?: IslandStatus
  maxVservers?: number
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createIsland(input: CreateIslandInput): Promise<Island> {
  const values: NewIsland = {
    host: input.host,
    grpcPort: input.grpcPort,
    region: input.region,
  }
  if (input.status !== undefined) values.status = input.status
  if (input.maxVservers !== undefined) values.maxVservers = input.maxVservers

  const rows = await db.insert(islands).values(values).returning()
  const row = rows[0]
  if (!row) throw new Error('Failed to insert island')
  return row
}

export async function getIslandById(id: string): Promise<Island | null> {
  const rows = await db.select().from(islands).where(eq(islands.id, id)).limit(1)
  return rows[0] ?? null
}

/** All islands, newest first. */
export async function listIslands(): Promise<Island[]> {
  return await db.select().from(islands).orderBy(asc(islands.region), asc(islands.host))
}

/** Islands in a single region (the scheduler's per-region candidate set). */
export async function listIslandsByRegion(region: string): Promise<Island[]> {
  return await db
    .select()
    .from(islands)
    .where(eq(islands.region, region))
    .orderBy(asc(islands.host))
}

export async function updateIsland(
  id: string,
  patch: UpdateIslandInput,
): Promise<Island> {
  const updates: Partial<NewIsland> = { updatedAt: new Date() }
  if (patch.host !== undefined) updates.host = patch.host
  if (patch.grpcPort !== undefined) updates.grpcPort = patch.grpcPort
  if (patch.region !== undefined) updates.region = patch.region
  if (patch.status !== undefined) updates.status = patch.status
  if (patch.maxVservers !== undefined) updates.maxVservers = patch.maxVservers

  const rows = await db.update(islands).set(updates).where(eq(islands.id, id)).returning()
  const row = rows[0]
  if (!row) throw new IslandNotFoundError(id)
  return row
}

export async function deleteIsland(id: string): Promise<void> {
  // FK from virtual_servers.island_id is ON DELETE SET NULL, so removing an
  // island simply unplaces its vServers (it does NOT delete them).
  const rows = await db.delete(islands).where(eq(islands.id, id)).returning({ id: islands.id })
  if (rows.length === 0) throw new IslandNotFoundError(id)
}

// ---------------------------------------------------------------------------
// Placement counts — the one derived signal the scheduler needs from the DB
// (the rest of its inputs are live Redis metrics, supplied at scoring time).
// ---------------------------------------------------------------------------

/** Number of vServers currently placed on each island, keyed by island id. */
export async function countVServersByIsland(): Promise<Map<string, number>> {
  const rows = await db
    .select({
      islandId: virtualServers.islandId,
      count: sql<number>`count(*)::int`,
    })
    .from(virtualServers)
    .where(sql`${virtualServers.islandId} IS NOT NULL`)
    .groupBy(virtualServers.islandId)

  const out = new Map<string, number>()
  for (const r of rows) {
    if (r.islandId) out.set(r.islandId, r.count)
  }
  return out
}

// ===========================================================================
// PUBLISHED SCHEDULER CONTRACT
//
// The bin-packing scheduler (next team) scores each candidate island from the
// shape below. The DURABLE half (`islandId`, `region`, `maxVservers`,
// `currentVserverCount`) comes from this module — see `toIslandScoringBase`.
// The LIVE half (`metrics`) is supplied AT SCORING TIME from Redis and is NOT
// persisted in Postgres (see ISLAND-PLATFORM.md). The scheduler:
//   1. filters islands to `status === 'active'` in the target region,
//   2. drops any where `currentVserverCount >= maxVservers` (hard cap),
//   3. scores the rest on the live `metrics` (lowest load wins).
// This mirrors the existing `RegionLoad` weighting in `lib/placement.ts`.
// ===========================================================================

/** LIVE per-island load, sourced from Redis at scoring time. */
export interface IslandLiveMetrics {
  /** Currently-connected users across all vServers on the island. */
  activeUsers: number
  /** CPU utilisation fraction [0,1]. */
  cpuPct: number
  /** Bandwidth utilisation fraction [0,1]. */
  bandwidthPct: number
}

/** The durable half of a scoring input — everything but the live metrics. */
export interface IslandScoringBase {
  islandId: string
  region: string
  maxVservers: number
  /** Derived from `countVServersByIsland` — placements already on this island. */
  currentVserverCount: number
}

/**
 * The full shape the scheduler scores. `metrics` is intersected in by the
 * caller from Redis; everything else is built here from the DB row + count.
 */
export interface IslandScoringInput extends IslandScoringBase {
  metrics: IslandLiveMetrics
}

/**
 * Project a DB island row + its current placement count into the durable half
 * of a scheduler scoring input. The caller intersects in the live `metrics`
 * (from Redis) to obtain a full `IslandScoringInput`.
 */
export function toIslandScoringBase(
  island: Island,
  currentVserverCount: number,
): IslandScoringBase {
  return {
    islandId: island.id,
    region: island.region,
    maxVservers: island.maxVservers,
    currentVserverCount,
  }
}

// ---------------------------------------------------------------------------
// Dashboard read model — islands with their placed vServers, plus the set of
// unplaced vServers (islandId IS NULL). Read-only aggregation for the admin UI.
// ---------------------------------------------------------------------------

export interface IslandWithVServers {
  island: Island
  vServers: VirtualServer[]
}

export interface IslandsOverview {
  islands: IslandWithVServers[]
  /** Managed vServers awaiting placement (islandId IS NULL). */
  unplaced: VirtualServer[]
}

export async function getIslandsOverview(): Promise<IslandsOverview> {
  const [allIslands, allVServers, unplacedVServers] = await Promise.all([
    listIslands(),
    db.select().from(virtualServers).orderBy(asc(virtualServers.createdAt)),
    db
      .select()
      .from(virtualServers)
      .where(isNull(virtualServers.islandId))
      .orderBy(asc(virtualServers.createdAt)),
  ])

  const byIsland = new Map<string, VirtualServer[]>()
  for (const vs of allVServers) {
    if (!vs.islandId) continue
    const list = byIsland.get(vs.islandId)
    if (list) list.push(vs)
    else byIsland.set(vs.islandId, [vs])
  }

  return {
    islands: allIslands.map((island) => ({
      island,
      vServers: byIsland.get(island.id) ?? [],
    })),
    unplaced: unplacedVServers,
  }
}
