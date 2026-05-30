/**
 * Live per-island metrics consumer.
 *
 * The Oracle scheduler reads FRESH per-island load (active users, CPU,
 * bandwidth) from Redis at placement time. The PUBLISHER side is the Go
 * server's `pkg/islandmetrics` (one publisher per Grumble process / island),
 * which writes a single HASH per island under
 * `island:{islandId}:metrics` with a TTL — see
 * `apps/hachiman-server/ISLAND-METRICS.md` for the wire contract.
 *
 * ── Schema (mirror of the Go side) ─────────────────────────────────────────
 *
 *   HASH  island:{islandId}:metrics
 *     activeUsers   int    — connected users across the island's vServers
 *     cpuPct        float  — CPU utilisation in [0,1] (currently stubbed at 0)
 *     bandwidthPct  float  — bandwidth utilisation in [0,1] (currently stubbed at 0)
 *     publishedAt   int64  — unix milliseconds at write time
 *   TTL = PublishInterval * StalenessMultiplier (default 5s * 3 = 15s)
 *
 * ── Staleness semantics ────────────────────────────────────────────────────
 *
 * Key absence = "no FRESH metrics from this island right now". The publisher
 * stops writing → Redis TTL expires the key within ~15s → HGETALL returns
 * empty → we OMIT that islandId from the returned map. The scheduler caller
 * then falls back to `MISSING_ISLAND_METRICS` (zero metrics) for that island,
 * which is exactly the same posture as an island that hasn't published yet.
 * This collapses "never published" and "stopped publishing" into a single
 * uniform signal at the API boundary, which is the cleanest contract — see
 * `scheduler-placement.ts` for the docstring on precedence.
 *
 * ── Connection lifecycle ───────────────────────────────────────────────────
 *
 * Lazy: the singleton client is constructed on first call. If REDIS_URL is
 * unset, this module returns an empty map immediately and never dials —
 * Oracle still works without Redis, the scheduler simply scores every island
 * on the MISSING fallback. `closeIslandMetricsClient()` is the shutdown hook
 * (useful in tests and in graceful process teardown).
 */
// ioredis is imported for its TYPE ONLY at module load. The actual Redis
// CONSTRUCTOR is loaded lazily inside createDefaultClient() — this lets the
// scheduler short-circuit (REDIS_URL unset → never instantiate) and lets unit
// tests inject a fake client without pulling the ioredis runtime + its full
// transitive dep tree (which would force a real `pnpm install` to succeed in
// the test environment). The type-only import compiles away entirely.
import type { Redis, RedisOptions } from 'ioredis'

import type { IslandLiveMetrics } from './islands'

// ---------------------------------------------------------------------------
// Wire contract — must stay in lock-step with pkg/islandmetrics/publisher.go
// ---------------------------------------------------------------------------

/** Hash key format for a given island. The publisher side mirrors this exactly. */
export function islandMetricsKey(islandId: string): string {
  return `island:${islandId}:metrics`
}

/** Field names inside the hash. Constants (vs. string literals at call sites)
 *  so a typo on either side breaks both, not just one. */
export const ISLAND_METRICS_FIELDS = {
  activeUsers: 'activeUsers',
  cpuPct: 'cpuPct',
  bandwidthPct: 'bandwidthPct',
  publishedAt: 'publishedAt',
} as const

/** Reading returned to the scheduler: the metrics plus the publishedAt
 *  timestamp (in case the caller wants to surface freshness; the scheduler
 *  itself doesn't consult it — TTL expiry already filters stale ones). */
export interface IslandMetricsReading {
  metrics: IslandLiveMetrics
  /** unix milliseconds at which the publisher wrote this snapshot. */
  publishedAt: number
}

// ---------------------------------------------------------------------------
// Singleton client — lazy, REDIS_URL-driven
// ---------------------------------------------------------------------------

let _client: Redis | null = null
let _disabled = false

/**
 * Construct a configured ioredis client from REDIS_URL. Async because the
 * `ioredis` module is loaded with dynamic import() — the SUT therefore does
 * not have a STATIC dependency on the ioredis runtime, which lets:
 *   - the no-Redis path skip loading it entirely, and
 *   - unit tests inject a fake via setIslandMetricsClient() without needing
 *     the full ioredis dep tree installed.
 *
 * NOTE: `lazyConnect: true` — we don't open the socket until the first
 * command. This keeps process startup cheap and avoids a noisy reconnect log
 * stream when Redis is briefly unavailable.
 */
async function createDefaultClient(url: string): Promise<Redis> {
  const { Redis: RedisCtor } = await import('ioredis')
  // Keep retries bounded so a permanently-misconfigured URL doesn't hammer
  // forever. ioredis's default retryStrategy backs off exponentially up to
  // 2s; we accept that.
  const opts: RedisOptions = {
    lazyConnect: true,
    // Treat a single command failure as a soft error rather than throwing
    // — getIslandMetrics() catches all errors and returns empty anyway.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  }
  return new RedisCtor(url, opts)
}

/** In-flight construction promise — prevents two concurrent first-callers
 *  from each instantiating their own client. */
let _clientPromise: Promise<Redis | null> | null = null

async function getClient(): Promise<Redis | null> {
  if (_disabled) return null
  if (_client) return _client
  if (_clientPromise) return _clientPromise
  const url = process.env.REDIS_URL
  if (!url) {
    // No Redis configured — Oracle is in self-host / no-metrics mode. Latch
    // _disabled so we don't recheck the env on every call.
    _disabled = true
    return null
  }
  _clientPromise = (async () => {
    try {
      _client = await createDefaultClient(url)
      return _client
    } catch {
      // Module load failed (ioredis not installed?) — latch disabled rather
      // than retrying on every call. Operator can fix the install and
      // restart.
      _disabled = true
      return null
    } finally {
      _clientPromise = null
    }
  })()
  return _clientPromise
}

/**
 * Test/admin override: inject a specific ioredis client (or `null` to force
 * the "no Redis" fallback). Resets the latched-disabled flag so the next call
 * may reconsider — important for tests that swap in a real client mid-suite.
 */
export function setIslandMetricsClient(client: Redis | null): void {
  // If the caller is replacing an existing real client, close it cleanly so
  // we don't leak sockets across test cases.
  if (_client && _client !== client) {
    void _client.quit().catch(() => undefined)
  }
  _client = client
  _disabled = client === null && process.env.REDIS_URL === undefined
}

/**
 * Graceful shutdown of the singleton client. Safe to call multiple times.
 * After this, the next getClient() will lazy-reconstruct from REDIS_URL.
 */
export async function closeIslandMetricsClient(): Promise<void> {
  if (!_client) return
  const c = _client
  _client = null
  _disabled = false
  try {
    await c.quit()
  } catch {
    // ioredis can throw on quit if already disconnected. We don't care —
    // the goal is "client is gone now".
  }
}

// ---------------------------------------------------------------------------
// Parsing — defensive, never throws on a malformed hash
// ---------------------------------------------------------------------------

/**
 * Parse a single HGETALL result into an `IslandMetricsReading`, or `null` if
 * the hash is missing/empty/unparseable. We are lenient on extra fields (the
 * publisher may add new ones in the future) and STRICT on the required
 * numeric fields — a non-numeric `activeUsers` etc. is treated as
 * "no reading" rather than a fabricated zero (which would corrupt scoring).
 *
 * Exported for unit testing; production callers go through getIslandMetrics.
 */
export function parseMetricsHash(
  hash: Record<string, string> | null | undefined,
): IslandMetricsReading | null {
  if (!hash || Object.keys(hash).length === 0) return null

  const rawUsers = hash[ISLAND_METRICS_FIELDS.activeUsers]
  const rawCPU = hash[ISLAND_METRICS_FIELDS.cpuPct]
  const rawBW = hash[ISLAND_METRICS_FIELDS.bandwidthPct]
  const rawPub = hash[ISLAND_METRICS_FIELDS.publishedAt]

  if (rawUsers === undefined || rawCPU === undefined || rawBW === undefined || rawPub === undefined) {
    return null
  }

  // activeUsers is published as a clean int string ("42"), but a defensive
  // parseInt + finite check guards against an operator HSET'ting garbage by
  // hand.
  const activeUsers = Number.parseInt(rawUsers, 10)
  const cpuPct = Number.parseFloat(rawCPU)
  const bandwidthPct = Number.parseFloat(rawBW)
  const publishedAt = Number.parseInt(rawPub, 10)

  if (
    !Number.isFinite(activeUsers) ||
    !Number.isFinite(cpuPct) ||
    !Number.isFinite(bandwidthPct) ||
    !Number.isFinite(publishedAt)
  ) {
    return null
  }

  return {
    metrics: { activeUsers, cpuPct, bandwidthPct },
    publishedAt,
  }
}

// ---------------------------------------------------------------------------
// Public API — what the scheduler calls
// ---------------------------------------------------------------------------

/**
 * Fetch FRESH per-island metrics for the given island ids. Returns a map
 * keyed by islandId; ids with no reading (no Redis, TTL-expired key, parse
 * error, or transport error) are OMITTED from the map, NOT zeroed. The
 * caller (see `scheduler-placement.ts`) is responsible for falling back to
 * `MISSING_ISLAND_METRICS` for absent ids.
 *
 * Distinguishing "absent" from "present-and-zero" is intentional: a stubbed
 * `cpuPct: 0` is a real reading (the publisher is alive, just doesn't have
 * an OS-level CPU sampler yet), whereas an absent key means we have NO
 * liveness signal at all. The scheduler treats them differently only in
 * logging / observability today, but the contract preserves the distinction.
 *
 * Empty input or no Redis → resolves to an empty Map. Never throws.
 */
export async function getIslandMetrics(
  islandIds: readonly string[],
): Promise<Map<string, IslandMetricsReading>> {
  const out = new Map<string, IslandMetricsReading>()
  if (islandIds.length === 0) return out

  const client = await getClient()
  if (!client) return out // REDIS_URL unset — silent no-op, fallback in caller

  // Pipeline so N HGETALLs go in one round trip. ioredis returns
  // [error, result] tuples per command; we tolerate per-island errors
  // (one bad key shouldn't mask the rest) but treat a pipeline-level
  // failure as "no metrics available" (return whatever we collected).
  const pipeline = client.pipeline()
  for (const id of islandIds) {
    pipeline.hgetall(islandMetricsKey(id))
  }

  let results: Array<[Error | null, unknown]> | null
  try {
    results = await pipeline.exec()
  } catch {
    // Connection refused, timeout, etc. — fall back to "no metrics".
    return out
  }

  if (!results) return out

  results.forEach((entry, idx) => {
    const id = islandIds[idx]
    if (id === undefined) return
    const [err, value] = entry
    if (err) return // per-command error → omit this id
    const reading = parseMetricsHash(value as Record<string, string> | null)
    if (reading) out.set(id, reading)
  })

  return out
}
