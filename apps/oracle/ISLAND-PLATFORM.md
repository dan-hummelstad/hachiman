# Island Platform

Status: **data model + admin-UI slice is real**; the runtime (k3s pods, wake
proxy, HAProxy, DNS SRV, Redis, the bin-packing scheduler) is **deferred** and
captured here as the contract those teams build against.

This realizes the `region → island → vServer` layering that
[`REGION-CONTRACT.md`](./REGION-CONTRACT.md) left as "Future / Not modeled yet".
That document still owns the **region** (logical, re-selectable) layer; this one
adds the **island** (physical Murmur host) and **vServer** (managed, placed
instance with a lifecycle) layers underneath it.

---

## 1. The realized layering

```
 region (LOGICAL)        island (PHYSICAL)            vServer (MANAGED)
 ----------------        -----------------            -----------------
 servers.region          islands row                  virtual_servers row
 e.g. "us-east"   ──►     one Murmur process    ──►    one in-process Murmur
 (REGION-CONTRACT)        (one k3s pod) in a           vServer, placed on an
                          region, hosting many         island (or unplaced)
                          vServers
```

- **region** — unchanged. A user-facing, mutable label on `servers.region`.
- **island** (`islands`) — one Murmur process / one k3s pod, living in exactly
  one region (`islands.region` → `regions.code`, `ON DELETE RESTRICT`). Hosts up
  to `maxVservers` in-process virtual servers. Reachable at `host:grpcPort` for
  control (start/stop a vServer).
- **vServer** (`virtual_servers`) — a managed Mumble instance with a lifecycle,
  backing exactly one registry server (`serverId`, unique 1:1). Placed onto an
  island (`islandId`, **nullable = unplaced**) by the scheduler.

### Data model (authoritative — see `src/db/schema.ts`, migration `drizzle/0000_*.sql`)

`islands`: `id` (uuid pk), `host` (text), `grpcPort` (int), `region`
(FK → `regions.code`, restrict), `status` (enum
`provisioning|active|draining|down`), `maxVservers` (int), `createdAt`,
`updatedAt`.

`virtual_servers`: `id` (uuid pk), `serverId` (**unique** FK → `servers.id`,
cascade), `status` (enum `inactive|starting|active|cooling`), `islandId`
(**nullable** FK → `islands.id`, set null), `murmurId` (int, the in-process
vServer id), `port` (int), `region` (FK → `regions.code`, restrict), `maxUsers`
(int), `maxBandwidth` (int, bits/sec), `lastActiveAt` (timestamptz null),
`createdAt`, `updatedAt`.

> **LIVE metrics are deliberately absent.** Active users, CPU, and bandwidth are
> per-island runtime signals that live in **Redis**, not Postgres. They are fed
> to the scheduler at scoring time. Storing them here would be stale the instant
> it's written. See §4.

### Key modeling decision: `virtual_servers.serverId` is a UNIQUE 1:1 FK to `servers`

A registry server is **either**:

- **self-hosted** — a `servers` row only (owner runs their own Murmur), **or**
- **managed** — a `servers` row **plus** exactly one `virtual_servers` row.

`serverId` is `NOT NULL UNIQUE` → strict 1:1. The registry server remains the
single source of identity (slug, owner, advertised host/port, OIDC client,
invites, region); `virtual_servers` adds **only** the managed
placement/lifecycle facts. This extends the existing model without duplicating
identity.

**Alternatives considered and rejected:**

| Alternative | Why rejected |
| --- | --- |
| **Merge fields into `servers`** (add `islandId`, `murmurId`, lifecycle `status`, …) | Pollutes every self-hosted row with always-null managed columns; mixes two lifecycles in one table; forces a nullable lifecycle enum whose "n/a" state is meaningless for self-hosted servers. |
| **`virtual_servers` as a standalone identity** (no link to `servers`) | Duplicates slug/owner/region/OIDC and splits "what clients connect to" across two tables; invites/verification/registry queries would need to union two identity sources. |
| **Many vServers per server** (drop the UNIQUE) | No product need — a registry entry is one logical voice server. Multiplicity belongs on the island (one island → many vServers), which the model already expresses. |
| **`servers.virtualServerId` (FK on `servers`)** | Inverts ownership; a managed-only attribute would hang off the shared registry table and every reader of `servers` would carry it. Keeping the FK on `virtual_servers` keeps managed concerns isolated. |

`ON DELETE` choices: `serverId` **cascade** (deleting the registry server tears
down its managed row; runtime teardown is separate/deferred). `islandId` **set
null** (removing an island unplaces its vServers rather than deleting them — the
scheduler re-homes them). Both `region` FKs **restrict** (a region with live
islands/vServers must not vanish underneath them — contrast `servers.region`,
which is `set null` because an unplaced self-hosted server is a valid state).

---

## 2. The vServer lifecycle state machine

Enforced by `transitionVServer(id, to)` in `src/lib/virtual-servers.ts` against
`VSERVER_TRANSITIONS`. A single one-directional cycle; every other jump
(including a no-op `X → X`) is rejected with `InvalidVServerTransitionError`.

```
        ┌───────────────────────────────────────────────┐
        │                                                │
   ┌────▼─────┐   wake    ┌──────────┐  booted  ┌────────┐  idle/drain  ┌─────────┐
   │ inactive │ ────────► │ starting │ ───────► │ active │ ───────────► │ cooling │
   └──────────┘           └──────────┘          └────────┘              └────┬────┘
        ▲                                                                     │
        │                          warm window elapses, no users             │
        └─────────────────────────────────────────────────────────────────────
```

- **inactive** — provisioned but running nowhere; `islandId` typically null.
- **starting** — placed on an island; the in-process Murmur vServer is booting.
- **active** — running and accepting users (`lastActiveAt` stamped).
- **cooling** — drained of users, kept warm briefly (`lastActiveAt` stamped) so
  a quick re-join doesn't pay a cold start; a sweep ages it back to inactive.

Placement (`islandId`) is orthogonal to lifecycle and has its own writes
(`placeVServer` / `unplaceVServer`): the scheduler places **before** `starting`
and unplaces **after** `cooling`, but the state machine does not couple them.

---

## 3. The bin-packing scheduler contract (next team)

Published from `src/lib/islands.ts`. The scheduler scores each **candidate
island** from this shape (`IslandScoringInput`):

```ts
interface IslandScoringInput {
  islandId: string
  region: string
  maxVservers: number
  currentVserverCount: number          // derived: countVServersByIsland()
  metrics: {                           // LIVE — supplied from Redis at scoring time
    activeUsers: number
    cpuPct: number                     // [0,1]
    bandwidthPct: number               // [0,1]
  }
}
```

The **durable half** (`islandId/region/maxVservers/currentVserverCount`) is built
by `toIslandScoringBase(island, count)`; the caller intersects in `metrics` from
Redis. Intended scoring procedure:

1. **Filter** to `status === 'active'` islands in the vServer's target region.
2. **Hard cap**: drop islands where `currentVserverCount >= maxVservers`.
3. **Score** the rest on `metrics` (lowest load wins); reuse the weighting in
   `src/lib/placement.ts` (`activeUsers/maxUsers·0.5 + cpu·0.3 + bw·0.2`).
4. Output a placement → `placeVServer(vsId, islandId)` then
   `transitionVServer(vsId, 'starting')`.

The scheduler is **pure scoring**: the DB helpers above are its only Postgres
dependency; everything load-related arrives as `metrics`.

---

## 4. Deferred runtime contract (infra teams)

None of the following exists yet. It is specified here so it can be built
**without re-touching this schema**, keyed off the columns shown.

- **One k3s pod per island.** A pod runs one Murmur process. Provisioning a pod
  creates the `islands` row (`status: provisioning → active` once healthy);
  draining flips it to `draining` (no new placements), then `down`. Keyed off:
  `island.id`, `island.host`, `island.grpcPort`, `island.maxVservers`.
- **Always-on wake proxy.** A tiny per-island (or per-region) listener on the
  Mumble port that accepts a client connection for a `cooling`/`inactive`
  vServer, asks the island over `grpcPort` to (re)start that `murmurId`, waits
  for `starting → active`, then splices the connection through. Keyed off:
  `vServer.islandId`, `vServer.murmurId`, `vServer.status`, `island.grpcPort`.
- **HAProxy L4 mapping.** A `port → island` map fronts the fleet so a client
  dialing `vServer.port` lands on the right island pod. Keyed off:
  `vServer.port`, `island.host`. Rebuilt on placement/unplacement.
- **DNS SRV registration.** Per managed server, an SRV record advertises the
  reachable endpoint (resolving to `island.host` + the L4 `vServer.port`). Keyed
  off the linked `servers` row + `vServer.port` + `island.host`.
- **Redis — live island metrics + session state.** Islands publish
  `{ activeUsers, cpuPct, bandwidthPct }` per `island.id` (the `metrics` half of
  §3) and hold transient session/wake state. **Authoritative for liveness;
  never mirrored into Postgres.**
  - The **island metrics** half is now shipped — see
    [`apps/hachiman-server/ISLAND-METRICS.md`](../hachiman-server/ISLAND-METRICS.md)
    for the schema + TTL/staleness model, plus the publisher
    (`apps/hachiman-server/pkg/islandmetrics`) and consumer
    (`apps/oracle/src/lib/island-metrics.ts`) wiring. The scheduler reads it
    in `scheduler-placement.ts`. Self-host zero-config is preserved: with
    no Redis URL set, nothing in the layer is started or contacted.
  - The **session/wake state** half is still deferred.

### Re-home / cold migration ties in here

`REGION-CONTRACT.md` §4 makes re-selecting `servers.region` the cold-migration
trigger. With this model that fan-out becomes concrete: pick a target island in
the new region (scheduler, §3), `placeVServer` onto it, drive the lifecycle
(`starting → active`), swap the HAProxy/DNS mapping, then `unplaceVServer` +
lifecycle-down the old placement. Still deferred — no consumer today.

---

## 5. Out of scope (this slice)

The k3s/HAProxy/DNS/Redis runtime, the scheduler implementation, the wake proxy,
per-island metric collection, and any cross-island migration mechanics. This
slice is the **data model + read API + admin dashboard + the published
contract** above — the foundation those build on.
