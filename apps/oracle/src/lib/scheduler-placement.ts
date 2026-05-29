/**
 * Thin scheduling entry point — the IMPURE wrapper around the pure
 * `scoreIslandPlacement` scorer (`scheduler.ts`). It reads candidate islands +
 * placement counts from the DB and, on a pick, writes placement + lifecycle.
 * The decision logic itself stays in the pure scorer; this file only does IO.
 *
 * It lives separately from `scheduler.ts` so the scorer module never imports
 * the DB client (keeping it pure + unit-testable without a `DATABASE_URL`).
 *
 * ── METRICS ARE AN INPUT, not fetched here ─────────────────────────────────
 *
 * Per the published contract (ISLAND-PLATFORM.md §3/§4 and `islands.ts`), live
 * per-island load (`activeUsers`/`cpuPct`/`bandwidthPct`) lives in REDIS — which
 * does not exist yet. So the caller supplies a `metricsByIsland` map; this
 * function does NOT reach for Redis. Islands missing from the map are scored
 * with zeroed metrics (`MISSING_ISLAND_METRICS`): they are NOT dropped, so a
 * brand-new active island that has not published metrics yet is still a
 * placement candidate (it simply scores on vServer-fill alone until its metrics
 * arrive). When the Redis layer is built, the caller fans the published metrics
 * into this map; no change is needed here.
 */
import {
  countVServersByIsland,
  listIslandsByRegion,
  toIslandScoringBase,
  type IslandLiveMetrics,
  type IslandScoringInput,
} from './islands'
import {
  scoreIslandPlacement,
  type IslandPlacementResult,
} from './scheduler'
import {
  getVServerById,
  placeVServer,
  transitionVServer,
  VirtualServerNotFoundError,
} from './virtual-servers'
import type { VirtualServer } from '@/db/schema'

/**
 * Live metrics assumed for an island absent from the supplied map. Zeroed =
 * "no observed pressure", so the island is scored on vServer-fill alone rather
 * than being excluded. A real Redis-backed caller would normally supply metrics
 * for every active island.
 */
export const MISSING_ISLAND_METRICS: IslandLiveMetrics = {
  activeUsers: 0,
  cpuPct: 0,
  bandwidthPct: 0,
}

/** Outcome of a scheduling attempt. */
export interface ScheduleOutcome {
  /** The scoring result (chosen island or `no-capacity` provision signal). */
  result: IslandPlacementResult
  /**
   * The placed + transitioned-to-`starting` vServer when an island was chosen;
   * `null` when the result was `no-capacity` (caller should provision a new
   * island and retry). Coherent with the place→transition invariant.
   */
  vServer: VirtualServer | null
}

/**
 * Pick an island for an already-region-targeted managed vServer and, on a pick,
 * commit the placement: `placeVServer(vsId, islandId)` then
 * `transitionVServer(vsId, 'starting')` — honouring the documented
 * place-before-`starting` coherence invariant in virtual-servers.ts.
 *
 * Flow:
 *   1. Load the vServer; derive its target `region` (already chosen upstream by
 *      the latency-based region scorer — we bin-pack WITHIN it).
 *   2. Fetch candidate islands in that region (`listIslandsByRegion`) and the
 *      per-island placement counts (`countVServersByIsland`).
 *   3. Keep only `status === 'active'` islands; build `IslandScoringInput` via
 *      `toIslandScoringBase` + the SUPPLIED `metricsByIsland` (Redis is an
 *      input, not fetched here — see the file header).
 *   4. Score with the pure `scoreIslandPlacement`.
 *   5. If an island was chosen → `placeVServer` then `transitionVServer(...,
 *      'starting')`, returning the updated row. If `no-capacity` → return the
 *      provision signal with `vServer: null` (placement/lifecycle untouched).
 *
 * @param vserverId  The managed vServer to place (must be `inactive` for the
 *                   `inactive → starting` transition to be legal).
 * @param metricsByIsland  Live per-island metrics keyed by islandId, supplied
 *                   by the caller from Redis. Islands not present are scored
 *                   with `MISSING_ISLAND_METRICS`.
 */
export async function scheduleVServerPlacement(
  vserverId: string,
  metricsByIsland: ReadonlyMap<string, IslandLiveMetrics>,
): Promise<ScheduleOutcome> {
  const vServer = await getVServerById(vserverId)
  if (!vServer) throw new VirtualServerNotFoundError(vserverId)

  // The region is already decided; the vServer carries its target region
  // denormalized (see schema.ts / ISLAND-PLATFORM.md).
  const region = vServer.region

  const [regionIslands, counts] = await Promise.all([
    listIslandsByRegion(region),
    countVServersByIsland(),
  ])

  // Step 1 of the documented procedure: only `active` islands are placeable
  // (provisioning/draining/down are not). Build the scoring inputs.
  const candidates: IslandScoringInput[] = regionIslands
    .filter((island) => island.status === 'active')
    .map((island) => ({
      ...toIslandScoringBase(island, counts.get(island.id) ?? 0),
      metrics: metricsByIsland.get(island.id) ?? MISSING_ISLAND_METRICS,
    }))

  const result = scoreIslandPlacement(candidates)

  if (result.chosen === null) {
    // No island has capacity → signal "provision a new one"; leave the vServer
    // unplaced and `inactive`. The pure scorer already set reason='no-capacity'.
    return { result, vServer: null }
  }

  // Commit the placement in the documented order: place onto the island FIRST,
  // THEN drive the lifecycle to `starting`. This preserves the coherence
  // invariant (a vServer is placed before it leaves `inactive`).
  await placeVServer(vserverId, result.chosen)
  const started = await transitionVServer(vserverId, 'starting')

  return { result, vServer: started }
}
