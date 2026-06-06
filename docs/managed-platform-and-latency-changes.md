# Managed platform + voice-latency changes

A summary of the work merged onto `main` on top of the in-flight UI WIP
(`dadcc53`). Scope: **78 files, ~+8,100 lines.** Everything below is merged and
verified green (oracle/hachiman/electron typechecks, `go build` + `pkg/web` &
`pkg/serverconf` tests, scheduler 15/15, placement 22/22, SSRF guard 19/0).
**Nothing is pushed — this is all local `main`.**

The work splits into two arcs:

1. **Latency features** — three Discord-borrowed ideas to keep voice latency low,
   first built behind honest placeholders, then **wired to real data**.
2. **Managed multi-tenant platform foundation** — the buildable, testable core
   of the islands/vServer hosting model (runtime infra deferred to design docs).

---

## 1. Voice region — a first-class, mutable property

A server's voice **region** is now a re-selectable property rather than a value
pinned at creation (the prerequisite for placing/re-homing a server near its
users).

- **Schema (Oracle / Drizzle):** a `regions` reference table (`code`,
  `displayName`, nullable `lat`/`lon`, and — added later — `probeHost`/
  `probePort`); a nullable, mutable `servers.region` FK.
- **API / lib:** `region` flows through `createServer`/`updateServer` and the
  `PATCH /api/servers/[id]` route; a public `GET /api/regions` exposes the set.
- **Dashboard:** editable region selector in the new-server and edit-server
  forms; region shown on the server detail + list.
- **Go server:** a `ServerRegion` config key (`cfg.StringValue("ServerRegion")`)
  so a running server knows the region it's homed in.
- **Contract:** `apps/oracle/REGION-CONTRACT.md` — the region → island → vServer
  layering and the re-home (cold-migration) intent.

## 2. Latency-based region recommendation

The client measures real round-trip latency to candidate regions and gets a
recommendation, instead of placing by owner location.

- **Pure scorer** `apps/oracle/src/lib/placement.ts` — region-affinity dominant
  (min-anchored tolerance buckets → a true total order, no intransitive
  comparator), then a bin-pack load tiebreak. Fully unit-tested
  (`placement.test.ts`, 22 cases incl. permutation-stability).
- **Endpoint** `POST /api/servers/recommend-region` — authed, Zod-validated,
  ignores unknown region codes (a stale client can't inject placements).
- **Prober** `pkgs/hachiman-node/src/region-rtt-probe.ts` — TCP-connect RTT with
  bounded concurrency; the Mumble UDP server-browser-ping wire format is
  implemented + unit-tested, ready for when the client gains raw UDP.
- **Real measurement path (Electron):** `IPlatformService.probeRegions` runs the
  node prober in the Electron **main** process via an `ipcMain`/preload bridge;
  the add-server flow shows measured per-region latency + the recommended region.
  The browser host is an honest no-op (no raw sockets).
- **Security:** the probe IPC is guarded by `probe-target-guard.ts` — DNS-resolve
  + reject non-public IPs (loopback/private/link-local/metadata/ULA, incl.
  DNS-rebinding), a `{64738, 443}` port allowlist, a count cap, and payload
  validation, so it can't be used as an SSRF / internal-port-scan primitive.
- **Design:** `apps/oracle/PLACEMENT-DESIGN.md`.

## 3. Connection quality + thin/on-path relay metrics

Live voice-health signals for end users and operators.

- **Client connection quality:** `hachiman-node` now subscribes to the Mumble
  `Ping` round-trip and emits a `connectionQuality` event — **RTT** from the Ping
  echo, **jitter + packet-loss from the WebRTC `RTCStats`** (the correct source
  for a WebRTC voice client; the server crypt counters are non-cumulative and
  don't apply). It flows through `VoiceService` → `voiceStore` → the indicator in
  `voice-controls.tsx`. Missing data renders as "—", never fabricated.
- **Relay instrumentation (Go SFU):** `pkg/web/relaymetrics.go` tags the relay
  with its region and counts forwarding hops on/off-path with **atomics only
  (0 alloc/op on the hot path)**; an off-path guard test + a latency-budget
  benchmark enforce "thin & on-path". `EvaluatePath` is the pure invariant.
- **Operator delivery (authenticated):** relay metrics reach the Health tab over
  a **new SuperUser-gated Mumble control-channel message**
  (`RelayMetricsQuery` → `RelayMetricsSnapshot`, message types **32/33**) via
  `IMumbleService.fetchRelayMetrics()`. The previously-open, unauthenticated
  `GET /metrics/relay` HTTP endpoint was **removed** (`ServeHTTP` retained for a
  private/localhost operator mount).
- **Design:** `apps/hachiman-server/THIN-RELAY-DESIGN.md`.

## 4. Managed multi-tenant platform foundation

The buildable core of the islands/vServer hosting model.

- **Data model (Oracle / Drizzle):**
  - `islands` — one Murmur process / k3s pod hosting many vServers, in a region
    (`host`, `grpcPort`, `region`, `status` [provisioning/active/draining/down],
    `maxVservers`).
  - `virtual_servers` — a managed Mumble instance with a lifecycle
    (`inactive → starting → active → cooling`), placed (or not) on an island.
    **1:1 with the registry:** `serverId` is a `NOT NULL UNIQUE` FK to
    `servers`, so a registry server is either **self-hosted** (a `servers` row
    only) or **managed** (`servers` + `virtual_servers`).
  - Lifecycle is the single guarded `status` write (`transitionVServer`);
    `unplaceVServer`/`deleteIsland` reset affected vServers to `inactive` so a
    vServer is never "active but nowhere".
  - Admin dashboard at `/admin/islands` (operator-gated) + read API.
- **Bin-packing scheduler** `apps/oracle/src/lib/scheduler.ts` — a **pure**,
  deterministic scorer (`fill*0.5 + cpu*0.3 + bw*0.2`, reusing the placement
  weights; least-loaded wins; total-order tie-break; "provision a new island"
  signal when all full). The DB-touching entry point
  (`scheduler-placement.ts`, `scheduleVServerPlacement`) is split out so the
  scorer stays pure + unit-testable (`scheduler.test.ts`, 15 cases). Live island
  metrics are an **input** (sourced from Redis later, not stored).
- **Selectable DB backend (Go server):** `pkg/database` now opens **SQLite**
  (self-host default, unchanged) or **Postgres** (managed) by
  `--database-driver`/`--database-dsn` (env `DATABASE_DRIVER`/`DATABASE_DSN`).
  Adds `gorm.io/driver/postgres`; fixed backtick-quoted identifiers that were
  invalid on Postgres. A non-empty unrecognised driver errors (doesn't silently
  write a local sqlite).
- **Design:** `apps/oracle/ISLAND-PLATFORM.md`.

---

## New / changed config + wire surface

| Kind | What |
| --- | --- |
| Go config keys | `ServerRegion`, `DatabaseDriver` (`sqlite`/`postgres`), `DatabaseDSN` |
| Mumble control-channel message | `RelayMetricsQuery` (32) → `RelayMetricsSnapshot` (33), SuperUser/root-Write gated |
| Public HTTP | `GET /api/regions` (Oracle); **removed** open `GET /metrics/relay` (Go) |
| Authed HTTP | `POST /api/servers/recommend-region` (Oracle) |
| Platform seam | `IPlatformService.probeRegions`; `IMumbleService.fetchRelayMetrics` + `connectionQuality` event |
| Drizzle migration | regenerated single baseline (project convention: regenerate, don't stack ALTERs) adding `regions`, `servers.region`, `islands`, `virtual_servers` |

## What needs to be done next

Ordered roughly by dependency. The foundation now **models** the platform and
**decides** placement, but nothing yet **runs** a managed vServer end-to-end —
that is the next arc.

### Near-term: harden + integrate what's merged
- **Push + open PR(s).** Everything is local on `main`; nothing is pushed.
- **Fix the electron `@/`-alias tsconfig gap** (pre-existing, not introduced
  here): the electron web project references `apps/hachiman/src` without
  re-declaring its `@/*` paths, so `pnpm -F @hachiman/hachiman-electron
  typecheck:web` reports ~36 errors. Small config fix; would block a strict host
  CI build.
- **Verify Postgres end-to-end:** run `AutoMigrate` + a CRUD round-trip against
  the docker-compose Postgres. The managed backend was compile/DryRun-verified
  only — no live Postgres was reachable in the build sandbox.
- **Make place+transition atomic:** wrap `placeVServer` + `transitionVServer` in
  one transaction in `scheduleVServerPlacement`. An up-front guard already
  prevents relocate-while-running; this closes the rarer mid-write DB fault.
- **Observe a live two-client call** to confirm the RTCStats connection-quality
  numbers render (verified by build/types, not yet seen on the wire).

### Next platform layer: actually host a managed vServer
- **Murmur internal gRPC management API** (the keystone — architecture mod #1):
  `CreateVirtualServer` / `DeleteVirtualServer` / `GetServerStats` / `SetConfig`
  on the Go server, so the control plane can instantiate/start/stop an in-process
  vServer. Today the scheduler picks an island and flips Postgres state to
  `starting`, but nothing tells that island's Murmur to boot the vServer — this
  API is the missing link between control-plane state and runtime.
- **Redis layer:** the ephemeral, session-scoped state the design calls for
  (`vserver:{id}` status, `island:{id}:metrics`). Have islands publish metrics
  and feed them into `scheduleVServerPlacement` (which already takes metrics as
  input), replacing `MISSING_ISLAND_METRICS`; distinguish "never published" (new
  island, treat idle) from "went stale" (deprioritise).
- **Wake proxy prototype:** the always-on per-island TCP/UDP proxy that checks
  Redis, triggers spinup, buffers the connection, then transparently proxies to
  Murmur — the scale-to-zero entry point. Locally prototypable.
- **Island health polling:** control plane polls each island (~5s) → Redis
  metrics, the input the scheduler and health views consume.

### Production deployment (design + manifests; can't run locally)
- **k3s** island pods + lifecycle (provision/drain/down) wired to the data model.
- **HAProxy (L4) config generation** from the control plane on vServer
  create/delete — keeping voice on a regional, on-path data path.
- **DNS SRV registration** (Cloudflare/Route53) so clients resolve a server by
  subdomain rather than a raw `host:port`.

### Smaller follow-ups
- `islands.maxUsers` (or a derived sum) for a user-utilisation term in the
  scheduler score, alongside the current vServer-fill term.
- Per-client region on the Go `Client` so the on-path classifier compares real
  participant regions instead of assuming directly-served clients are in-region.
- Wire the UDP server-browser-ping prober (already implemented + tested) once the
  TS client gains a raw UDP transport.
- Regional TURN URIs in the SFU's ICE config (empty today) for the browser path.
- Centralised auth webhook (architecture mod #2): extend the existing Oracle
  token introspection so Murmur resolves allow/deny + ACLs centrally on connect.
