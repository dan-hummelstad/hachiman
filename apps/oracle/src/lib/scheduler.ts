/**
 * Bin-packing island scheduler — the PURE scorer (no DB, no IO, no clock).
 * The thin DB-touching entry point that wraps it (`scheduleVServerPlacement`)
 * lives in the sibling `scheduler-placement.ts` so THIS module stays pure and
 * does not even transitively import the DB client.
 *
 * Picks which ISLAND a managed vServer should be placed on, WITHIN a region
 * that has already been chosen. Region selection is the latency-based scorer in
 * `lib/placement.ts`; this module bin-packs inside the winning region: of the
 * `status === 'active'` islands there, place on the LEAST-LOADED one with spare
 * capacity. If none has capacity, it signals "provision a new island" rather
 * than picking anything.
 *
 * ── Scoring formula (least-loaded wins; lower score = better) ───────────────
 *
 *     load = fillFrac      * 0.5    where fillFrac = currentVserverCount/maxVservers
 *          + cpuPct        * 0.3
 *          + bandwidthPct  * 0.2
 *     (each term in [0,1]; inputs are clamped to [0,1].)
 *
 * This mirrors the architecture's bin-pack weighting `0.5/0.3/0.2` and reuses
 * `placement.ts`'s `LOAD_WEIGHTS` as the SINGLE source of truth for those
 * numbers (see `ISLAND_LOAD_WEIGHTS` below) — no re-hardcoded magic numbers.
 *
 * ── vServer-fill vs. user-utilisation for the 0.5 term ──────────────────────
 *
 * The architecture's formula uses `active_users / max_users` for the weighted
 * 0.5 capacity term. The published island contract (`IslandScoringInput` in
 * `lib/islands.ts`) intentionally does NOT expose a per-island `maxUsers` — an
 * island hosts many vServers, each with its OWN `maxUsers`, and there is no
 * island-wide user ceiling in the P1 schema. It exposes `cpuPct` + `bandwidthPct`
 * as [0,1] fractions and the vServer FILL (`currentVserverCount / maxVservers`).
 *
 * We therefore use the vServer-FILL fraction for the 0.5 capacity term. This is
 * the right capacity signal for BIN-PACKING anyway: the hard constraint we are
 * packing against is "vServers per island" (`maxVservers`, the documented hard
 * cap), and CPU/bandwidth already carry the live resource pressure. Raw
 * `activeUsers` is still surfaced on each ranked entry for observability, but it
 * is NOT fed into the score because normalising it would require an island-wide
 * user ceiling the contract doesn't define.
 *
 * RECOMMENDED CONTRACT EXTENSION (not done here — would re-open the P1 schema):
 * if a genuine island-wide user-utilisation term is later wanted, add an
 * `islands.maxUsers` (or publish a derived `maxUsers` sum on `IslandScoringBase`)
 * and a `userFrac = activeUsers / maxUsers` term. We deliberately did NOT touch
 * the P1 schema for this; vServer-fill is sufficient and contract-faithful.
 */
import type {
  IslandScoringBase,
  IslandScoringInput,
} from './islands'
import { LOAD_WEIGHTS } from './placement'

// ---------------------------------------------------------------------------
// Weights — SINGLE source of truth, reused from placement.ts.
//
// placement.ts exports `LOAD_WEIGHTS = { users: 0.5, cpu: 0.3, bandwidth: 0.2 }`.
// The island scorer's 0.5 term is the vServer-FILL fraction rather than a
// user-utilisation fraction (see the file header for why), so we re-export the
// same numbers under fill-oriented names. We do NOT redefine the magic numbers;
// `ISLAND_LOAD_WEIGHTS.fill === LOAD_WEIGHTS.users` etc., keeping one source.
// ---------------------------------------------------------------------------
export const ISLAND_LOAD_WEIGHTS = {
  /** Weight on vServer fill (`currentVserverCount / maxVservers`). */
  fill: LOAD_WEIGHTS.users,
  /** Weight on CPU utilisation. */
  cpu: LOAD_WEIGHTS.cpu,
  /** Weight on bandwidth utilisation. */
  bandwidth: LOAD_WEIGHTS.bandwidth,
} as const

const clamp01 = (n: number): number =>
  !Number.isFinite(n) || n < 0 ? 0 : n > 1 ? 1 : n

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** One scored island in the ranking, with the components that ordered it. */
export interface RankedIsland {
  islandId: string
  /** Bin-pack load score in [0,1] (lower = less loaded = preferred). */
  loadScore: number
  /** Clamped vServer-fill fraction used in the score (`current / max`). */
  fillFrac: number
  /** Clamped CPU fraction used in the score. */
  cpuPct: number
  /** Clamped bandwidth fraction used in the score. */
  bandwidthPct: number
  /** Raw live active-user count (observability only — NOT part of the score). */
  activeUsers: number
}

/**
 * Result of scoring a candidate set for ONE placement.
 *
 * `chosen` is the islandId to place on, or `null` when no candidate has spare
 * capacity (all at the hard cap, or the input was empty) — the documented
 * "provision a new island" signal. `reason` is set iff `chosen === null`.
 */
export interface IslandPlacementResult {
  /** The chosen islandId, or `null` = provision a new island. */
  chosen: string | null
  /** Set only when `chosen === null`. Why no island was picked. */
  reason: 'no-capacity' | null
  /** Candidates that had capacity, ordered best (least-loaded) → worst. */
  ranking: RankedIsland[]
  /** islandIds dropped because they were at the hard cap (`current >= max`). */
  atCapacity: string[]
}

// ---------------------------------------------------------------------------
// The hard cap + the load score (both PURE).
// ---------------------------------------------------------------------------

/**
 * An island is at its hard cap when it already hosts `>= maxVservers`
 * placements. A non-positive `maxVservers` means the island can host nothing,
 * so it is also "at capacity" (and never chosen). Such islands are dropped from
 * candidacy before scoring (ISLAND-PLATFORM.md §3 step 2).
 */
export function isAtCapacity(input: IslandScoringBase): boolean {
  return input.maxVservers <= 0 || input.currentVserverCount >= input.maxVservers
}

/**
 * Bin-pack load score for an island in [0,1] (lower = less loaded). All three
 * components are clamped to [0,1]; the fill fraction is `currentVserverCount /
 * maxVservers`. Pure: same input ⇒ same output.
 *
 * Callers should only score islands that passed `isAtCapacity === false`
 * (`maxVservers > 0` is then guaranteed, so the division is well-defined), but
 * the clamp keeps the result in range even if a caller passes a saturated one.
 */
export function islandLoadScore(input: IslandScoringInput): number {
  const fillFrac = clamp01(
    input.maxVservers > 0 ? input.currentVserverCount / input.maxVservers : 1,
  )
  const cpu = clamp01(input.metrics.cpuPct)
  const bw = clamp01(input.metrics.bandwidthPct)
  return (
    fillFrac * ISLAND_LOAD_WEIGHTS.fill +
    cpu * ISLAND_LOAD_WEIGHTS.cpu +
    bw * ISLAND_LOAD_WEIGHTS.bandwidth
  )
}

// ---------------------------------------------------------------------------
// The pure scorer.
// ---------------------------------------------------------------------------

/**
 * Score a candidate island set for ONE vServer placement and pick the
 * least-loaded island with spare capacity. PURE — no DB, no IO, no clock.
 *
 * The caller MUST have already filtered `candidates` to `status === 'active'`
 * islands in the vServer's target region (see `scheduleVServerPlacement`). This
 * function then:
 *   1. drops islands at the hard cap (`currentVserverCount >= maxVservers`),
 *   2. scores the rest by load (lowest wins),
 *   3. returns the winner + a full ranking, or a `no-capacity` provision signal
 *      when nothing remains (all full / empty input).
 *
 * Determinism: ties are broken by lower `loadScore`, then lexicographically
 * lower `islandId`, so the output is independent of input order.
 */
export function scoreIslandPlacement(
  candidates: IslandScoringInput[],
): IslandPlacementResult {
  const atCapacity: string[] = []
  const ranking: RankedIsland[] = []

  for (const c of candidates) {
    if (isAtCapacity(c)) {
      atCapacity.push(c.islandId)
      continue
    }
    const fillFrac = clamp01(c.currentVserverCount / c.maxVservers)
    const cpuPct = clamp01(c.metrics.cpuPct)
    const bandwidthPct = clamp01(c.metrics.bandwidthPct)
    ranking.push({
      islandId: c.islandId,
      loadScore: islandLoadScore(c),
      fillFrac,
      cpuPct,
      bandwidthPct,
      activeUsers: c.metrics.activeUsers,
    })
  }

  // Least-loaded wins; deterministic tie-break by islandId. A total order, so
  // the result does not depend on the candidate input order.
  ranking.sort((a, b) => {
    if (a.loadScore !== b.loadScore) return a.loadScore - b.loadScore
    return a.islandId < b.islandId ? -1 : a.islandId > b.islandId ? 1 : 0
  })

  const chosen = ranking[0]?.islandId ?? null
  return {
    chosen,
    reason: chosen === null ? 'no-capacity' : null,
    ranking,
    atCapacity,
  }
}
