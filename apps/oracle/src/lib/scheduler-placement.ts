/**
 * Thin scheduling entry point — the IMPURE wrapper around the pure
 * `scoreIslandPlacement` scorer (`scheduler.ts`). It reads candidate islands +
 * placement counts from the DB and, on a pick, writes placement + lifecycle.
 * The decision logic itself stays in the pure scorer; this file only does IO.
 *
 * It lives separately from `scheduler.ts` so the scorer module never imports
 * the DB client (keeping it pure + unit-testable without a `DATABASE_URL`).
 *
 * ── METRICS PRECEDENCE (Redis live → caller-supplied → MISSING fallback) ───
 *
 * Per the published contract (ISLAND-PLATFORM.md §3/§4 and `islands.ts`), live
 * per-island load (`activeUsers`/`cpuPct`/`bandwidthPct`) lives in REDIS. This
 * function consults THREE sources, in order of precedence:
 *
 *   1. FRESH Redis publication for the island id (TTL'd, fetched here via
 *      `getIslandMetrics(activeIslandIds)`). Wins when present.
 *   2. CALLER-SUPPLIED `metricsByIsland` map. Used only for ids that have no
 *      fresh Redis reading. Lets the caller seed test metrics or override the
 *      scheduler from an experimental data source without unplugging Redis.
 *   3. `MISSING_ISLAND_METRICS` fallback (zeroed). Used for ids absent from
 *      both sources — a brand-new island that hasn't published yet, or an
 *      island whose publisher has stopped (its key expired). In either case
 *      the island stays a placement candidate but scores on vServer-fill only.
 *
 * The "stopped publishing" vs "never published" distinction collapses to the
 * same Redis-side signal (key absent), which is the cleanest contract — the
 * caller doesn't need a separate "is stale" flag. With Redis disabled (no
 * `REDIS_URL`) `getIslandMetrics` returns an empty map and we fall through
 * to the caller-supplied / MISSING path uniformly.
 */
import {
  countVServersByIsland,
  listIslandsByRegion,
  toIslandScoringBase,
  type IslandLiveMetrics,
  type IslandScoringInput,
} from './islands'
import { getIslandMetrics } from './island-metrics'
import {
  scoreIslandPlacement,
  type IslandPlacementResult,
} from './scheduler'
import {
  canTransitionVServer,
  getVServerById,
  InvalidVServerTransitionError,
  placeVServer,
  transitionVServer,
  VirtualServerNotFoundError,
  type VServerView,
} from './virtual-servers'

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
  vServer: VServerView | null
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
 *   3. Filter to `status === 'active'` islands.
 *   4. Pull FRESH metrics from Redis for those active islands
 *      (`getIslandMetrics`), then merge — Redis WINS over the caller-supplied
 *      map for any id present in both. See the file header for the full
 *      precedence model (Redis → caller → MISSING fallback).
 *   5. Build `IslandScoringInput` via `toIslandScoringBase` + the merged
 *      metrics map (with `MISSING_ISLAND_METRICS` as a last-resort default
 *      so a brand-new island still scores on vServer-fill alone).
 *   6. Score with the pure `scoreIslandPlacement`.
 *   7. If an island was chosen → `placeVServer` then `transitionVServer(...,
 *      'starting')`, returning the updated row. If `no-capacity` → return the
 *      provision signal with `vServer: null` (placement/lifecycle untouched).
 *
 * @param vserverId  The managed vServer to place (must be `inactive` for the
 *                   `inactive → starting` transition to be legal).
 * @param metricsByIsland  Caller-supplied per-island metrics keyed by islandId,
 *                   used as a SECONDARY source for ids without a fresh Redis
 *                   reading. Pass an empty Map for the pure-Redis flow.
 *                   Islands absent from BOTH sources are scored with
 *                   `MISSING_ISLAND_METRICS`.
 */
export async function scheduleVServerPlacement(
  vserverId: string,
  metricsByIsland: ReadonlyMap<string, IslandLiveMetrics>,
): Promise<ScheduleOutcome> {
  const vServer = await getVServerById(vserverId)
  if (!vServer) throw new VirtualServerNotFoundError(vserverId)

  // Coherence guard, fail-fast BEFORE any read/score/write: only a vServer that
  // can legally transition to `starting` (i.e. `inactive`) is placeable. Without
  // this, an already-running vServer would be relocated by `placeVServer` and
  // only THEN rejected by `transitionVServer` — committing the island
  // reassignment while leaving it un-transitioned (placed-while-running).
  if (!canTransitionVServer(vServer.status, 'starting')) {
    throw new InvalidVServerTransitionError(vServer.status, 'starting')
  }

  // The region is already decided; the vServer carries its target region
  // denormalized (see schema.ts / ISLAND-PLATFORM.md). A NULL region means
  // the vServer was created without one (e.g. through the dashboard's
  // optional region field) — it's unschedulable until set. Surface that as
  // an empty-island-set scoring outcome rather than crashing the scheduler
  // on a null-region listIslandsByRegion call.
  const region = vServer.region
  if (region === null) {
    return {
      result: {
        chosen: null,
        reason: 'no-capacity',
        ranking: [],
        atCapacity: [],
      },
      vServer: null,
    }
  }

  const [regionIslands, counts] = await Promise.all([
    listIslandsByRegion(region),
    countVServersByIsland(),
  ])

  // Step 1 of the documented procedure: only `active` islands are placeable
  // (provisioning/draining/down are not). Compute the active set once so we
  // can pass its ids to the Redis fetch and reuse them for scoring.
  const activeIslands = regionIslands.filter((island) => island.status === 'active')
  const activeIslandIds = activeIslands.map((island) => island.id)

  // Fetch FRESH metrics for the active set. With no REDIS_URL, this resolves
  // to an empty map and we fall through to the caller-supplied path
  // immediately — preserving the pre-Redis behaviour. Errors inside the
  // consumer are swallowed and returned as an empty map; we never crash the
  // scheduler over a Redis hiccup.
  const fresh = await getIslandMetrics(activeIslandIds)

  // Merge: Redis WINS over the caller-supplied map. `metricsByIsland` is the
  // SECONDARY source for ids that have no fresh Redis reading (e.g. an island
  // that just spun up and hasn't published yet, or stopped publishing and
  // had its key TTL-expire).
  const candidates: IslandScoringInput[] = activeIslands.map((island) => {
    const freshReading = fresh.get(island.id)
    const supplied = metricsByIsland.get(island.id)
    const metrics = freshReading?.metrics ?? supplied ?? MISSING_ISLAND_METRICS
    return {
      ...toIslandScoringBase(island, counts.get(island.id) ?? 0),
      metrics,
    }
  })

  const result = scoreIslandPlacement(candidates)

  if (result.chosen === null) {
    // No island has capacity → signal "provision a new one"; leave the vServer
    // unplaced and `inactive`. The pure scorer already set reason='no-capacity'.
    return { result, vServer: null }
  }

  // Commit the placement in the documented order: place onto the island FIRST,
  // THEN drive the lifecycle to `starting`. The up-front guard above guarantees
  // the transition is legal, so the only residual gap is a transient DB fault
  // BETWEEN these two writes — they are not yet wrapped in a single transaction
  // (a follow-up for when the live scheduler/runtime is wired; harmless today as
  // there is no caller, and re-running re-places idempotently).
  await placeVServer(vserverId, result.chosen)
  const started = await transitionVServer(vserverId, 'starting')

  return { result, vServer: started }
}
