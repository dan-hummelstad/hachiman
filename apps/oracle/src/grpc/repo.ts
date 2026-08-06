/**
 * MediaNodesRepo — the storage seam for the media-plane gRPC handlers.
 *
 * Production wires Drizzle via `drizzleMediaNodesRepo`. Tests inject an
 * in-memory implementation (see ./placement.test.ts / ./media-nodes.test.ts)
 * so the same handler code path runs without DATABASE_URL or a live Postgres,
 * AND so the behavioural test cases exercise the real production handlers
 * rather than re-implementations of them.
 *
 * The interface is deliberately narrow — one method per behaviour the
 * handlers need. Adding raw SQL access here would re-create the
 * "placement-rank lives parallel to placement.ts" drift problem the HIGH #1
 * fix-pass eliminated. If a future RPC needs a fundamentally new query
 * (e.g. a tenant-scoped LIST endpoint) it gets its own method here, with the
 * Drizzle implementation + in-memory test impl updated in lockstep.
 */
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm'

import { db } from '../db/client'
import { mediaNodes } from '../db/schema'

export interface PlacementCandidate {
  nodeId: string
  sidechannelAddr: string
  tenantId: string | null
  activeSessions: number
  region: string
  status: string
  lastHeartbeatAt: Date
}

export interface FindEligibleCandidateInput {
  region: string
  /** Empty string = no tenant filter. Non-empty = match NULL or this tenant. */
  tenantId: string
  /** Rows older than this are excluded as stale. */
  staleCutoff: Date
}

export interface StampTenantInput {
  nodeId: string
  /** Always non-empty when invoked — empty-tenant placements skip the stamp
   *  call entirely in pickPlacement. */
  tenantId: string
}

export interface UpsertMediaNodeInput {
  nodeId: string
  region: string
  capacity: { cpu_cores: number; max_sessions: number }
  lastHeartbeatAt: Date
  version: string
  sidechannelAddr: string
}

export interface HeartbeatMediaNodeInput {
  nodeId: string
  lastHeartbeatAt: Date
  activeSessions: number
  cpuFraction: number
  accepting: boolean
}

/**
 * MediaNodesRepo encapsulates every storage interaction the gRPC handlers
 * need. The handlers know nothing about Drizzle; production wires Drizzle
 * here, tests wire an in-memory map.
 */
export interface MediaNodesRepo {
  /**
   * Find the single best-scoring eligible candidate for placement. Returns
   * undefined when none match. Sort order is well-defined for determinism:
   * lowest activeSessions first, ties broken by ascending nodeId.
   *
   * Filter contract (must match across all implementations):
   *   - region = input.region
   *   - status = 'active'
   *   - lastHeartbeatAt > input.staleCutoff
   *   - tenantId IS NULL OR tenantId = input.tenantId  (skipped when
   *     input.tenantId is empty)
   */
  findEligibleCandidate(input: FindEligibleCandidateInput): Promise<PlacementCandidate | undefined>

  /**
   * Atomically claim the node for the given tenant. Returns the post-claim
   * candidate on success; returns undefined when the row was concurrently
   * stamped by a different tenant (the CRITICAL #2 race window).
   *
   * Contract: stamps only when tenant_id IS NULL OR tenant_id = input.tenantId.
   */
  stampTenant(input: StampTenantInput): Promise<PlacementCandidate | undefined>

  /**
   * Upsert media node row. Inserts when missing; on conflict updates
   * region/capacity/version/status/lastHeartbeatAt/sidechannelAddr but
   * NEVER touches tenantId (partition recovery preserves the binding).
   */
  upsertMediaNode(input: UpsertMediaNodeInput): Promise<void>

  /**
   * Apply a heartbeat. Returns true when the row existed and was updated,
   * false when no row matches (handler maps this to NOT_FOUND). status
   * transitions: dead stays dead; accepting=true → active; accepting=false → draining.
   */
  applyHeartbeat(input: HeartbeatMediaNodeInput): Promise<boolean>
}

/** Production Drizzle implementation. Lives here (not in placement.ts) so the
 *  handler files are pure orchestration — no SQL strings, no schema imports. */
export const drizzleMediaNodesRepo: MediaNodesRepo = {
  async findEligibleCandidate({ region, tenantId, staleCutoff }) {
    const tenantFilter =
      tenantId === ''
        ? sql`true`
        : or(isNull(mediaNodes.tenantId), eq(mediaNodes.tenantId, tenantId))
    const rows = await db
      .select({
        nodeId: mediaNodes.nodeId,
        sidechannelAddr: mediaNodes.sidechannelAddr,
        tenantId: mediaNodes.tenantId,
        activeSessions: mediaNodes.activeSessions,
        region: mediaNodes.region,
        status: mediaNodes.status,
        lastHeartbeatAt: mediaNodes.lastHeartbeatAt,
      })
      .from(mediaNodes)
      .where(
        and(
          eq(mediaNodes.region, region),
          eq(mediaNodes.status, 'active'),
          gt(mediaNodes.lastHeartbeatAt, staleCutoff),
          tenantFilter,
        ),
      )
      // Composite index idx_media_nodes_placement on (region, status,
      // last_heartbeat_at) covers the WHERE filters; the ORDER BY sort
      // runs on the already-narrow result set.
      .orderBy(asc(mediaNodes.activeSessions), asc(mediaNodes.nodeId))
      .limit(1)
    const r = rows[0]
    if (!r) return undefined
    return {
      nodeId: r.nodeId,
      sidechannelAddr: r.sidechannelAddr ?? '',
      tenantId: r.tenantId,
      activeSessions: r.activeSessions,
      region: r.region,
      status: r.status,
      lastHeartbeatAt: r.lastHeartbeatAt,
    }
  },

  async stampTenant({ nodeId, tenantId }) {
    const stamped = await db
      .update(mediaNodes)
      .set({ tenantId })
      .where(
        and(
          eq(mediaNodes.nodeId, nodeId),
          or(isNull(mediaNodes.tenantId), eq(mediaNodes.tenantId, tenantId)),
        ),
      )
      .returning({
        nodeId: mediaNodes.nodeId,
        sidechannelAddr: mediaNodes.sidechannelAddr,
        tenantId: mediaNodes.tenantId,
        activeSessions: mediaNodes.activeSessions,
        region: mediaNodes.region,
        status: mediaNodes.status,
        lastHeartbeatAt: mediaNodes.lastHeartbeatAt,
      })
    const w = stamped[0]
    if (!w) return undefined
    return {
      nodeId: w.nodeId,
      sidechannelAddr: w.sidechannelAddr ?? '',
      tenantId: w.tenantId,
      activeSessions: w.activeSessions,
      region: w.region,
      status: w.status,
      lastHeartbeatAt: w.lastHeartbeatAt,
    }
  },

  async upsertMediaNode({ nodeId, region, capacity, lastHeartbeatAt, version, sidechannelAddr }) {
    await db
      .insert(mediaNodes)
      .values({
        nodeId,
        region,
        capacity,
        lastHeartbeatAt,
        version,
        status: 'active',
        sidechannelAddr,
        // tenantId stays null on register — only stamped on first
        // PlaceMediaSession that lands a non-empty tenant.
      })
      .onConflictDoUpdate({
        target: mediaNodes.nodeId,
        set: {
          region,
          capacity,
          version,
          status: 'active',
          lastHeartbeatAt,
          sidechannelAddr,
          // NOTE: tenantId NOT updated here — re-registering after a
          // partition must not clear the active-tenant binding.
        },
      })
  },

  async applyHeartbeat({ nodeId, lastHeartbeatAt, activeSessions, cpuFraction, accepting }) {
    const updated = await db
      .update(mediaNodes)
      .set({
        lastHeartbeatAt,
        activeSessions,
        cpuFraction,
        // accepting=false transitions the node to `draining` (no new
        // placements; existing sessions kept). accepting=true marks it
        // `active`. We don't have a way back from `dead` here — that's
        // sweeper-only.
        status: sql`CASE WHEN ${mediaNodes.status} = 'dead' THEN 'dead' WHEN ${accepting ? sql`true` : sql`false`} THEN 'active' ELSE 'draining' END`,
      })
      .where(eq(mediaNodes.nodeId, nodeId))
      .returning({ nodeId: mediaNodes.nodeId })
    return updated.length > 0
  },
}
