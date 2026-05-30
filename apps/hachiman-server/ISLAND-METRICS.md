# Island Live Metrics — Publisher & Consumer Contract

Status: **shipped, opt-in**. Realizes the Redis half of the deferred runtime
contract in [`apps/oracle/ISLAND-PLATFORM.md` §4](../oracle/ISLAND-PLATFORM.md).
Self-host (no Redis configured) is unchanged — the publisher is gated and
nothing runs.

This is the wire contract between:

- **publisher** — `apps/hachiman-server/pkg/islandmetrics` (Go; one per
  Grumble process / island)
- **consumer** — `apps/oracle/src/lib/island-metrics.ts` (TypeScript; read at
  scheduler placement time in `scheduler-placement.ts`)

Both sides MUST stay in lock-step. Key format + field names + value encoding
are encoded as constants on each side (`MetricsKey`, `ISLAND_METRICS_FIELDS`)
so a rename on one side without the other surfaces as an obvious symbol error
rather than silent runtime drift.

---

## 1. Schema

One HASH per island, written by the island's own publisher, with a TTL.

```
KEY    island:{islandId}:metrics
TYPE   HASH

FIELD          TYPE     MEANING
activeUsers    int      Currently-connected clients across all in-process vServers
cpuPct         float    CPU utilisation in [0,1] (see §3 — currently stubbed at 0)
bandwidthPct   float    Bandwidth utilisation in [0,1] (see §3 — currently stubbed at 0)
publishedAt    int64    Unix milliseconds at write time

TTL    PublishInterval * StalenessMultiplier  (default 5s * 3 = 15s)
```

The publisher writes HSET + EXPIRE in one pipeline per tick. The consumer
HGETALLs per island in a single pipeline.

### Why a HASH, not a JSON blob

Each field is a small primitive; HSET writes them atomically into one key and
HGETALL reads them back without parsing JSON. Future fields (e.g. a region
label, a build version, a per-vServer breakdown) extend the hash without any
schema migration on either side — the consumer ignores unknown fields.

### Why a TTL, not a "stale" flag

A TTL turns "publisher stopped" into an observable signal (the key disappears
within ~15s) without requiring liveness pings or a sweeper. The consumer
treats key-absence as "no fresh metrics" and the scheduler caller falls back
to `MISSING_ISLAND_METRICS` for that island. Crucially this collapses two
runtime scenarios — "never published" (brand-new island) and "stopped
publishing" (dead island) — into the same uniform Redis-side signal at the
API boundary, which keeps the consumer logic simple.

---

## 2. Staleness semantics — precedence at the scheduler

`scheduler-placement.ts:scheduleVServerPlacement` consults THREE sources for
per-island metrics, in order of precedence:

1. **FRESH Redis publication** for the islandId (TTL'd, fetched via
   `getIslandMetrics`). Wins when present.
2. **Caller-supplied `metricsByIsland` map**. Used only when Redis has no
   reading. Lets callers seed test metrics or wire an experimental source
   without unplugging Redis.
3. **`MISSING_ISLAND_METRICS` fallback** (zeroed). Used for ids absent from
   both — a brand-new island that hasn't published yet, or one whose publisher
   has stopped (TTL-expired key). The island stays a placement candidate but
   scores on vServer-fill only (CPU/bandwidth weighted 0).

With `REDIS_URL` unset, `getIslandMetrics` returns an empty map immediately
and we fall through to (2)/(3) uniformly — Oracle still works without Redis.

---

## 3. CPU & bandwidth — stubbed at 0 today

The current publisher reports `activeUsers` accurately (sum of
`len(server.clients)` across all in-process vServers) but writes `cpuPct = 0`
and `bandwidthPct = 0`. Both are placeholders for runtime-team follow-ups:

- **CPU**: needs a per-process %CPU sampler. On the deployed Linux target
  this is a `/proc/self/stat` reading delta-divided by wall-clock. Reporting
  e.g. `runtime.NumGoroutine()` instead would be misleading — we'd rather
  publish 0 than fabricate.
- **Bandwidth**: Grumble's per-client `BandwidthRecorder` (see
  `cmd/grumble/bandwidth_recorder.go`) already samples a per-second
  bandwidth in bits/sec. An island-wide fraction would be
  `sum(client.Bandwidth) / (MaxBandwidth * num_clients)` per vServer,
  averaged across vServers. Wiring this requires widening the
  `ClientCounter` interface (currently exposing only `ClientCount()`) and
  is left to the follow-up.

A stubbed 0 is SAFE for the scheduler: `placement.ts` weights cpu=0.3 and
bandwidth=0.2; with both at 0 the score collapses to `0.5 *
fillFrac`, i.e. pure vServer-fill bin-packing — exactly the behaviour the
scheduler had before this layer existed. As soon as the real samplers land,
the score reflects them automatically with no client-side change.

---

## 4. Configuration (server side)

All three keys default to disabled. The publisher only starts when BOTH
`IslandMetricsRedisURL` and `IslandMetricsIslandID` are non-empty.

| serverconf key                       | CLI flag                                  | Env                                      | Default | Meaning                                                    |
| ------------------------------------ | ----------------------------------------- | ---------------------------------------- | ------- | ---------------------------------------------------------- |
| `IslandMetricsRedisURL`              | `--island-metrics-redis-url`              | `ISLAND_METRICS_REDIS_URL`               | `""`    | redis:// URL. Empty → disabled.                            |
| `IslandMetricsIslandID`              | `--island-metrics-island-id`              | `ISLAND_METRICS_ISLAND_ID`               | `""`    | UUID matching the Oracle `islands.id` row. Empty → disabled. |
| `IslandMetricsPublishIntervalSec`    | `--island-metrics-publish-interval-sec`   | `ISLAND_METRICS_PUBLISH_INTERVAL_SEC`    | `5`     | Tick interval; TTL is 3x this.                             |

**Zero-config self-host preserved**: with both URL and IslandID empty (the
default), `cmd/grumble/main()` never constructs the publisher — no Redis
connection, no goroutine, no extra log lines. Identical to behaviour pre-P5.

---

## 5. Configuration (consumer / Oracle side)

| env       | Default | Meaning                                                                                  |
| --------- | ------- | ---------------------------------------------------------------------------------------- |
| `REDIS_URL` | unset | redis:// URL. Unset → `getIslandMetrics` returns empty map immediately (no Redis dialed). |

The consumer uses a lazy singleton ioredis client (dynamic-import so the
no-Redis path never loads the runtime). `closeIslandMetricsClient()` is
available for graceful shutdown and test isolation.

---

## 6. Failure modes

| Scenario                          | Publisher behaviour              | Consumer behaviour                       | Scheduler effect                            |
| --------------------------------- | -------------------------------- | ---------------------------------------- | ------------------------------------------- |
| Redis unreachable                 | Logs each failed publish, retries | Returns empty Map (per-pipeline error)   | Falls back to caller-supplied / MISSING.    |
| Redis briefly unreachable + back  | Logs N misses, then resumes     | Reads resume on next call               | Brief MISSING window during outage.         |
| Publisher process crashes         | (gone)                           | Key TTL-expires within ~15s             | Island scored on MISSING after TTL.         |
| Hand-edited malformed hash field  | n/a                              | Returns null reading (parse fails)      | Island omitted, scored on MISSING fallback. |
| `REDIS_URL` unset (Oracle)        | n/a                              | Empty Map every call (no dial)          | Always uses caller-supplied / MISSING.     |
| URL + IslandID empty (Grumble)    | Publisher never started          | n/a                                      | No-op; scheduler sees no fresh metrics.    |

The publisher MUST NOT block the voice hot path — it runs on its own ticker
and reads the registry snapshot under no caller-held lock. Publication
failures are logged and swallowed; nothing in the publish loop can stall the
serving code.

---

## 7. Smoke recipe

```bash
# Start Redis
docker compose -f docker/docker-compose.yml up -d redis

# Start a Grumble process configured as an "island"
go run ./apps/hachiman-server/cmd/grumble \
  --datadir /tmp/island-1-data \
  --island-metrics-redis-url redis://127.0.0.1:6379 \
  --island-metrics-island-id 550e8400-e29b-41d4-a716-446655440000 \
  --island-metrics-publish-interval-sec 5

# In another shell — verify the key + TTL
docker exec redis redis-cli HGETALL island:550e8400-e29b-41d4-a716-446655440000:metrics
docker exec redis redis-cli TTL    island:550e8400-e29b-41d4-a716-446655440000:metrics
# Expect: hash with activeUsers/cpuPct/bandwidthPct/publishedAt; TTL ~15s.
```

When the publisher is stopped, the key disappears within `~15s` (the TTL).
Restarting it republishes within one `PublishInterval`.
