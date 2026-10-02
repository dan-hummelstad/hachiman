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
 * (e.g. a region-scoped LIST endpoint) it gets its own method here, with the
 * Drizzle implementation + in-memory test impl updated in lockstep.
 */
import { and, asc, eq, gt, sql } from 'drizzle-orm'

import { db } from '../db/client'
import { mediaNodes } from '../db/schema'

export interface PlacementCandidate {
  nodeId: string
  signalingUrl: string
  activeSessions: number
  region: string
  status: string
  lastHeartbeatAt: Date
}

export interface FindEligibleCandidateInput {
  /** Empty = any region (guild has no region preference). */
  region: string
  /** Rows older than this are excluded as stale. */
  staleCutoff: Date
}

export interface UpsertMediaNodeInput {
  nodeId: string
  region: string
  capacity: { cpu_cores: number; max_sessions: number }
  lastHeartbeatAt: Date
  version: string
  signalingUrl: string
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
   */
  findEligibleCandidate(input: FindEligibleCandidateInput): Promise<PlacementCandidate | undefined>

  /**
   * Upsert media node row. Inserts when missing; on conflict updates
   * region/capacity/version/status/lastHeartbeatAt/signalingUrl but keeps
   * the heartbeat counters.
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
  async findEligibleCandidate({ region, staleCutoff }) {
    const rows = await db
      .select({
        nodeId: mediaNodes.nodeId,
        signalingUrl: mediaNodes.signalingUrl,
        activeSessions: mediaNodes.activeSessions,
        region: mediaNodes.region,
        status: mediaNodes.status,
        lastHeartbeatAt: mediaNodes.lastHeartbeatAt,
      })
      .from(mediaNodes)
      .where(
        and(
          region ? eq(mediaNodes.region, region) : undefined,
          eq(mediaNodes.status, 'active'),
          gt(mediaNodes.lastHeartbeatAt, staleCutoff),
        ),
      )
      // Composite index idx_media_nodes_placement on (region, status,
      // last_heartbeat_at) covers the WHERE filters; the ORDER BY sort
      // runs on the already-narrow result set.
      .orderBy(asc(mediaNodes.activeSessions), asc(mediaNodes.nodeId))
      .limit(1)
    return rows[0]
  },

  async upsertMediaNode({ nodeId, region, capacity, lastHeartbeatAt, version, signalingUrl }) {
    await db
      .insert(mediaNodes)
      .values({
        nodeId,
        region,
        capacity,
        lastHeartbeatAt,
        version,
        status: 'active',
        signalingUrl,
      })
      .onConflictDoUpdate({
        target: mediaNodes.nodeId,
        set: {
          region,
          capacity,
          version,
          status: 'active',
          lastHeartbeatAt,
          signalingUrl,
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
