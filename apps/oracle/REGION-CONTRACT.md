# Region Contract

Status: **stable for the data-model + UI slice**. The managed-infra pieces
(islands, scheduler, wake proxy, placement scorer) described under "Future" do
**not** exist yet — this document is the contract downstream teams code against
so those pieces can be built without re-touching the registry schema.

A server's **region** is a first-class, **mutable, re-selectable** property
(Discord-style), not a value pinned at creation. Re-selecting a region is the
logical trigger for a future "re-home" (cold migration) of the server's voice
placement closer to its users.

---

## 1. Data model (authoritative)

Defined in `apps/oracle/src/db/schema.ts`; migrated by
`apps/oracle/drizzle/0000_*.sql` (regenerated cleanly — not stacked ALTERs).

### `regions` — reference table (small, fixed, seeded)

| column         | type                          | notes                                              |
| -------------- | ----------------------------- | -------------------------------------------------- |
| `code`         | `text` **PK**                 | machine code, lowercase kebab, e.g. `us-east`      |
| `display_name` | `text` NOT NULL               | human label, e.g. `US East`                        |
| `lat`          | `double precision` (nullable) | rough region centroid; future geodesic scoring only |
| `lon`          | `double precision` (nullable) | rough region centroid; future geodesic scoring only |
| `created_at`   | `timestamptz` NOT NULL        | default `now()`                                    |

Seeded idempotently by `apps/oracle/src/db/seed.ts` (`pnpm -F @hachiman/oracle db:seed`),
keyed on `code` via `onConflictDoUpdate`. Initial set:

| code           | display_name              | lat      | lon       |
| -------------- | ------------------------- | -------- | --------- |
| `us-east`      | US East                   | 39.0438  | -77.4874  |
| `us-west`      | US West                   | 45.5946  | -121.1787 |
| `eu-west`      | EU West                   | 53.3331  | -6.2489   |
| `ap-southeast` | Asia Pacific (Southeast)  | 1.3521   | 103.8198  |

`lat`/`lon` are deliberately rough and **nullable**; nothing reads them today.
They exist so a future placement scorer can compute geodesic distance from a
user population to a region centroid. Treat them as advisory, not precise.

### `servers.region` — the mutable property

A nullable `region text` column on the existing `servers` table:

```sql
"region" text REFERENCES "regions"("code") ON DELETE SET NULL
```

- **Nullable** — a server may be unplaced (legacy rows, or created without a
  region). `null` is a valid, expected state meaning "no region selected".
- **Mutable** — owners re-select it from the dashboard at any time.
- **`ON DELETE SET NULL`** — retiring a region `code` never cascades into
  deleting servers; affected servers simply become unplaced.
- The FK guarantees a non-null `region` always references an existing
  `regions.code`. Application-layer Zod (`regionCodeSchema`) additionally
  shape-checks codes before they reach the DB.

---

## 2. TypeScript type names (authoritative)

Exported from `apps/oracle/src/db/schema.ts`:

| Type        | Meaning                                  |
| ----------- | ---------------------------------------- |
| `Region`    | `typeof regions.$inferSelect` (a row)    |
| `NewRegion` | `typeof regions.$inferInsert` (insert)   |
| `Server`    | now includes `region: string \| null`    |
| `NewServer` | now includes optional `region`           |

Validation (`apps/oracle/src/lib/server-schemas.ts`):

- `regionCodeSchema` — `string`, lowercase kebab, 2–32 chars.
- `createServerSchema.region` — optional + nullable (initial region).
- `updateServerSchema.region` — optional + nullable (`null` clears it).

Server-side helpers (`apps/oracle/src/lib/servers.ts`):

- `createServer(input)` — sets initial `region` (`input.region ?? null`).
- `updateServer(id, patch)` — persists `region` when present in the patch. This
  is the **single region-write path** (the dashboard and the future re-home
  fan-out both go through it), so the cold-migration trigger has exactly one
  call site to hook: the `region` branch of `updateServer`. (No standalone
  `setServerRegion` exists today — it would be speculative with no consumer;
  extract one from that branch when the fan-out is actually built.)
- `listRegions(): Promise<Region[]>` — ordered by `display_name`; populates the
  dashboard `<Select>` and (later) the placement scorer.

Client mirror — **forward-declared for Team B, NOT yet populated** (obeys the
Zustand selector rules in `CLAUDE.md`):

- `apps/hachiman/src/services/OracleService.ts` — `RemoteServerRecord.region?: string | null`.
- `apps/hachiman/src/stores/serverStore.ts` — `Server.region?: string | null`.

  These give region-aware client code a typed slot, but nothing writes them yet:
  `/api/me/servers` serializes `user_servers` rows, which have no region column.
  The eventual source is the `servers` registry table — wiring that up is Team
  B's job, not this slice's.

Go server (`apps/hachiman-server/pkg/serverconf/config.go`):

- `DefaultCfg["ServerRegion"] = ""` — read via `cfg.StringValue("ServerRegion")`.
  Empty = unplaced. Informational today; the future placement layer consumes it.

---

## 3. region → island → vServer mapping (the layered model)

```
 region (LOGICAL)          island (PHYSICAL)            vServer (FUTURE)
 ----------------          -----------------            ----------------
 servers.region            a runnable host/zone         a placed Mumble
 e.g. "us-east"   ──►       within a region    ──►       instance bound to
 (this contract)           (managed-infra, TBD)         an island (TBD)
```

- **region** (logical) — what this contract owns *today*. A user-facing,
  re-selectable label. The only piece persisted in the registry.
- **island** (physical) — a concrete machine / availability zone *inside* a
  region where voice can actually run. One region maps to one-or-more islands.
  **Not modeled yet** — downstream infra team owns this. It will likely key off
  `regions.code` (and may use `lat`/`lon` to pick the nearest island).
- **vServer** (future) — a specific placed/running Mumble instance bound to an
  island, fronted by a wake proxy/scheduler. **Not modeled yet.**

Downstream teams: depend only on `regions.code` and `servers.region` as the
join key. Do **not** assume an island/vServer schema shape — that is yours to
define and is intentionally absent here.

---

## 4. Re-homing as a future cold-migration trigger

Selecting a new `region` on an existing server is the **logical signal** to
re-home it. The mechanics do not exist yet; the intended future shape:

1. Owner picks a new region in the dashboard → PATCH `/api/servers/[id]` →
   `updateServer` writes `servers.region` (this is all that happens **today**).
2. **Future:** that write fans out to the managed-infra layer, which:
   - selects a target **island** in the new region (geodesic scoring via
     `lat`/`lon` + user population),
   - **cold-migrates** the vServer: drain/announce → spin up on the new island →
     swap the advertised host → tear down the old placement.
3. Because this is a cold migration, the UI already warns the owner that
   changing region "may briefly interrupt voice" (see `edit-server-form.tsx`).

`region` is written in exactly one place — the `region` branch of `updateServer`
(`apps/oracle/src/lib/servers.ts`) — so the fan-out in step 2 has a single call
site to hook, and re-home auditing / rate-limiting can be added there. When the
fan-out is built it may be worth extracting that branch into a dedicated re-home
function; it is intentionally NOT split out today because there is no consumer.

### Explicitly out of scope (do not build against assumptions here)

Islands, the scheduler, the wake proxy, the placement scorer, per-region
metrics, and any vServer lifecycle. Only the `regions` table + `servers.region`
column + the helper/contract above are real today.
