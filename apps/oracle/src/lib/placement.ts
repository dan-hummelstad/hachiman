/**
 * Latency-based region placement scorer — PURE. No DB, no IO, no clock.
 *
 * Given a set of candidate regions, each carrying a *measured* client→region
 * round-trip time (RTT) and optional load metrics, this ranks them and picks
 * the one a server should be homed in.
 *
 * Design intent (see PLACEMENT-DESIGN.md and REGION-CONTRACT.md):
 *
 *  - Region affinity is the DOMINANT term: the region with the lowest measured
 *    RTT to the user(s) wins. Nearness-to-users is what actually moves voice
 *    latency; an SFU sitting on the network path is roughly neutral.
 *
 *  - The bin-pack score is only a SECONDARY tiebreaker. When two regions are
 *    effectively the same distance away (their RTTs fall within a tolerance
 *    band of each other), we prefer the one that is less loaded so we spread
 *    placement instead of hot-spotting one island. A materially closer region
 *    NEVER loses to a less-loaded-but-farther region.
 *
 *    bin-pack load = (activeUsers / maxUsers) * 0.5
 *                  + cpuPct                    * 0.3
 *                  + bandwidthPct              * 0.2
 *    (each component in [0,1]; lower is better / less loaded.)
 *
 * The scorer is deliberately tolerant of missing data: a region with no load
 * metrics is treated as load-unknown and ordered purely by its RTT (and, on a
 * tie-band with a region that *does* have load, the one with known-lower load
 * is preferred). A region with no measured RTT cannot be affinity-ranked and
 * is excluded from candidacy (it is reported separately).
 */

/** Optional per-region load metrics. All components are fractions in [0,1]. */
export interface RegionLoad {
  /** Currently-connected users on the region's placement. */
  activeUsers?: number
  /** Capacity used for the utilisation fraction. */
  maxUsers?: number
  /** CPU utilisation fraction [0,1]. */
  cpuPct?: number
  /** Bandwidth utilisation fraction [0,1]. */
  bandwidthPct?: number
}

/** A region the scorer may choose, with its measured RTT + optional load. */
export interface RegionCandidate {
  /** Region machine code, e.g. "us-east". */
  code: string
  /**
   * Measured client→region round-trip time in milliseconds. `null`/`undefined`
   * means "not measured" — such a region is excluded from the ranking.
   */
  rttMs?: number | null
  /** Optional bin-pack inputs; absent ⇒ load-unknown. */
  load?: RegionLoad
}

/** One ranked candidate in the output, with the scores that ordered it. */
export interface RankedRegion {
  code: string
  rttMs: number
  /** Bin-pack load score in [0,1] (lower = less loaded). `null` if unknown. */
  loadScore: number | null
}

export interface PlacementResult {
  /** The recommended region code, or `null` if there were no rankable candidates. */
  recommended: string | null
  /** Candidates ordered best→worst (RTT-dominant, load tiebreak). */
  ranking: RankedRegion[]
  /** Codes dropped because they carried no measured RTT. */
  unrankable: string[]
}

export interface PlacementOptions {
  /**
   * RTT tolerance band, in milliseconds. Two regions whose RTTs differ by no
   * more than this are considered "equally near" and the load tiebreak decides
   * between them. Outside the band, the lower RTT always wins. Default 15ms —
   * below human-perceptible voice difference, wide enough to absorb probe
   * jitter.
   */
  rttToleranceMs?: number
}

const DEFAULT_RTT_TOLERANCE_MS = 15

// Bin-pack weights. Exported so tests (and the future scheduler) assert against
// the single source of truth rather than re-hardcoding magic numbers.
export const LOAD_WEIGHTS = {
  users: 0.5,
  cpu: 0.3,
  bandwidth: 0.2,
} as const

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n)

/**
 * Compute the bin-pack load score for a region, or `null` when no load signal
 * is present at all. Components that are individually missing contribute 0
 * (treated as "no observed pressure from this dimension"); a region with *zero*
 * load fields is load-unknown and returns `null`.
 */
export function loadScore(load: RegionLoad | undefined): number | null {
  if (!load) return null

  const hasUsers =
    typeof load.activeUsers === 'number' &&
    typeof load.maxUsers === 'number' &&
    load.maxUsers > 0
  const hasCpu = typeof load.cpuPct === 'number'
  const hasBandwidth = typeof load.bandwidthPct === 'number'

  if (!hasUsers && !hasCpu && !hasBandwidth) return null

  const usersFrac = hasUsers ? clamp01(load.activeUsers! / load.maxUsers!) : 0
  const cpuFrac = hasCpu ? clamp01(load.cpuPct!) : 0
  const bwFrac = hasBandwidth ? clamp01(load.bandwidthPct!) : 0

  return (
    usersFrac * LOAD_WEIGHTS.users +
    cpuFrac * LOAD_WEIGHTS.cpu +
    bwFrac * LOAD_WEIGHTS.bandwidth
  )
}

/**
 * Rank candidate regions and pick one. Pure: same input ⇒ same output.
 *
 * Ordering rule (RTT-dominant, load secondary):
 *   1. If |rttA − rttB| > tolerance  → lower RTT wins (affinity dominates).
 *   2. Else (same tie-band)          → lower load score wins; a region with a
 *      known load score beats one whose load is unknown; if both unknown, the
 *      (marginally) lower RTT wins, then `code` for a stable, deterministic order.
 */
export function scorePlacement(
  candidates: RegionCandidate[],
  options: PlacementOptions = {},
): PlacementResult {
  const tolerance = options.rttToleranceMs ?? DEFAULT_RTT_TOLERANCE_MS

  const unrankable: string[] = []
  const ranked: RankedRegion[] = []

  for (const c of candidates) {
    if (typeof c.rttMs !== 'number' || !Number.isFinite(c.rttMs) || c.rttMs < 0) {
      // No usable RTT (missing/NaN/Infinity) or a nonsensical negative RTT:
      // cannot be affinity-ranked, reported separately.
      unrankable.push(c.code)
      continue
    }
    ranked.push({ code: c.code, rttMs: c.rttMs, loadScore: loadScore(c.load) })
  }

  // Affinity-dominant ordering, expressed as a TOTAL order. A tolerance band
  // used directly as the primary comparison is intransitive (A≈B and B≈C, yet
  // A≫C), which makes Array.sort input-order-dependent and can rank a
  // materially-farther region first. Instead, anchor fixed-width tolerance
  // buckets at the closest RTT: bucket 0 holds every region within `tolerance`
  // of the nearest, and a region more than `tolerance` slower than the nearest
  // lands in a higher bucket and can never outrank it — regardless of load.
  // Within a bucket, the bin-pack load score breaks the tie.
  const minRtt = ranked.reduce((m, r) => (r.rttMs < m ? r.rttMs : m), Infinity)
  // `tolerance <= 0` disables banding: each distinct RTT is its own bucket, so
  // any RTT difference dominates (load only breaks exact-RTT ties).
  const bucketOf = (rttMs: number): number =>
    tolerance > 0 ? Math.floor((rttMs - minRtt) / tolerance) : rttMs

  ranked.sort((a, b) => {
    // 1. Affinity dominance via min-anchored tolerance buckets (total order).
    const bucketA = bucketOf(a.rttMs)
    const bucketB = bucketOf(b.rttMs)
    if (bucketA !== bucketB) return bucketA - bucketB
    // 2. Same proximity band → the bin-pack load tiebreak applies.
    const aHasLoad = a.loadScore !== null
    const bHasLoad = b.loadScore !== null
    if (aHasLoad && bHasLoad) {
      if (a.loadScore !== b.loadScore) return a.loadScore! - b.loadScore!
    } else if (aHasLoad !== bHasLoad) {
      // Prefer the region whose load we actually know (and can balance against).
      return aHasLoad ? -1 : 1
    }
    // 3. Still tied: lower RTT, then code, for a stable deterministic order.
    if (a.rttMs !== b.rttMs) return a.rttMs - b.rttMs
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
  })

  return {
    recommended: ranked[0]?.code ?? null,
    ranking: ranked,
    unrankable,
  }
}
