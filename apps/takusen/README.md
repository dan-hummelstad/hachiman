# Takusen

Takusen is the identity provider and the REST API of Hachiman. It owns the Postgres schema, stores file bytes in S3 and publishes gateway events to Redis. It is also the MLS delivery service (DS) for end-to-end encryption: it orders commits, holds proposals and group state, and checks membership. It never makes a commit and never decrypts. A separate gRPC process keeps the media node registry, places voice sessions, runs the MLS batch scheduler and signs the key transparency tree heads.

The wire contract for each boundary is [`docs/gateway-protocol.md`](../../docs/gateway-protocol.md). The repo-level picture is in the root [`README.md`](../../README.md).

## Where it fits

```mermaid
flowchart LR
  C["Host apps<br/>(Electron, Browser)"]
  E["Electron main<br/>region probe"]
  G["hachiman-gateway"]
  M["hachiman-media"]

  subgraph T["Takusen"]
    N["Next.js :3000<br/>OIDC, /api/v1, dashboard"]
    R["gRPC process<br/>127.0.0.1:50051"]
  end

  PG[("Postgres")]
  RD[("Redis")]
  S3[("S3 / SeaweedFS")]

  C -- "HTTPS: OIDC PKCE /api/oidc" --> N
  C -- "HTTPS: REST /api/v1, Bearer" --> N
  E -- "HTTPS: GET /api/regions" --> N
  G -- "HTTPS: GET /api/v1/users/@me" --> N
  G -- "gRPC: PlaceMediaSession" --> R
  M -- "gRPC: RegisterMediaNode,<br/>MediaNodeHeartbeat" --> R
  N -- "SQL: Drizzle" --> PG
  R -- "SQL: media_nodes" --> PG
  N -- "PUBLISH guild:{id}, user:{id},<br/>device:{id}" --> RD
  N -- "PUBLISH takusen:mls_wakeup" --> RD
  RD -- "SUBSCRIBE takusen:mls_wakeup" --> R
  R -- "PUBLISH device:{id}<br/>(MLS_BATCH_ASSIGN), user:{id}<br/>(KT_TREE_HEAD)" --> RD
  R -- "SQL: mls_*, kt_*" --> PG
  RD -- "PSUBSCRIBE" --> G
  N -- "S3 API: put, get, delete" --> S3
```

- **Host apps → Takusen (OIDC).** The apps sign in with Authorization Code + PKCE against `/api/oidc` as the public client `hachiman-client`. Electron gets the callback through `/oauth/electron-bridge`. See [`docs/takusen-sso-setup.md`](../../docs/takusen-sso-setup.md).
- **Host apps → Takusen (REST).** The apps call `/api/v1` with the access token as a bearer token. Uploads and downloads also go through Takusen, so clients never touch the bucket. Contract §4.
- **Electron main → Takusen.** The main process reads the public `GET /api/regions` and probes each region for RTT. A client can then send the RTTs to `POST /api/v1/regions/recommend`. See [`PLACEMENT-DESIGN.md`](PLACEMENT-DESIGN.md).
- **Gateway → Takusen (REST).** At IDENTIFY, the gateway calls `GET /api/v1/users/@me` to check the token. The gateway reads Postgres directly for READY.
- **Gateway → Takusen (gRPC).** The gateway calls `PlaceMediaSession` when a voice channel has no media node. Contract §9.
- **Media → Takusen (gRPC).** Each media node calls `RegisterMediaNode` at start and `MediaNodeHeartbeat` at an interval. Contract §9.
- **Takusen → Redis.** After each REST mutation commits, Takusen publishes the gateway event on `guild:{id}`, `user:{id}` or `device:{id}`. Each gateway node subscribes. Contract §5.
- **Takusen → its gRPC process.** When a Remove or an Add is queued, Takusen publishes `takusen:mls_wakeup`. The gRPC process then gives the batch to one online member device. Contract §12.7.5.
- **Takusen → Postgres.** Takusen owns the schema and the migrations. Contract §3.

## Code architecture

```mermaid
flowchart TB
  subgraph APP["src/app"]
    AUTHG["(auth)<br/>login, signup, reset"]
    DASH["(dashboard)<br/>account, admin"]
    PAGES["oidc/interaction, invite,<br/>oauth/electron-bridge"]
    OIDCR["api/oidc/[...path]"]
    NA["api/auth/[...nextauth]"]
    V1["api/v1/*<br/>REST handlers"]
    UPR["api/v1/uploads,<br/>api/v1/files"]
    REG["api/regions"]
  end

  MW["middleware.ts<br/>CORS"]
  AUTHJS["auth.ts<br/>Auth.js"]
  AH["lib/auth-helpers.ts<br/>requireUser()"]
  OP["lib/oidc-provider.ts"]
  OA["lib/oidc-adapter.ts"]
  OI["lib/oidc-interaction.ts"]
  GA["lib/guild-access.ts<br/>permissions"]
  GL["lib/guilds.ts, invites.ts,<br/>invite-limits.ts,<br/>invite-history.ts"]
  WIRE["lib/wire.ts<br/>row to wire shape"]
  UP["lib/uploads.ts<br/>claims"]
  FI["lib/files.ts<br/>pure helpers"]
  ST["lib/storage.ts<br/>S3 client"]
  EV["lib/events.ts<br/>publishToGuild()<br/>publishToUser()"]
  PL["lib/placement.ts<br/>region scorer"]
  DB["db/client.ts, schema.ts"]

  subgraph GRPC["src/grpc (separate process)"]
    GM["main.ts, server.ts"]
    GP["proto.ts<br/>management.proto"]
    GN["media-nodes.ts"]
    GPL["placement.ts"]
    GR["repo.ts<br/>MediaNodesRepo"]
    GRM["repo.in-memory.ts<br/>(tests)"]
  end

  MW -.-> V1
  AUTHG --> AUTHJS
  DASH --> AH
  NA --> AUTHJS
  PAGES --> OI
  OIDCR --> OP
  OI --> OP
  OP --> OA
  OA --> DB
  V1 --> AH
  AH --> AUTHJS
  AH --> OP
  V1 --> GA
  V1 --> GL
  V1 --> WIRE
  V1 --> UP
  V1 --> EV
  V1 --> PL
  GA --> EV
  GA --> DB
  GL --> DB
  GL --> EV
  UP --> FI
  UP --> DB
  UPR --> FI
  UPR --> ST
  REG --> DB
  GM --> GP
  GM --> GN
  GM --> GPL
  GN --> GR
  GPL --> GR
  GR --> DB
  GRM -.-> GR
```

| Path | What |
|---|---|
| `src/app/(auth)/` | Sign-in, sign-up, forgot-password and reset-password pages. Server actions in `actions.ts`. |
| `src/app/(dashboard)/` | Signed-in dashboard: `dashboard`, `account` and `admin` pages. |
| `src/app/(marketing)/page.tsx` | Landing page at `/`. |
| `src/app/oidc/interaction/[uid]/` | OIDC login and consent screen. It is a page, not an API route, so it can read the Auth.js session. |
| `src/app/invite/[code]/` | Public invite preview page. It links to `HACHIMAN_WEB_URL` and to `takusen://invite/<code>`. The client component `open-invite-buttons.tsx` adds the `#k=` key of an invite with history to both links, and removes it from the address bar (contract §11 "Invite links"). `src/lib/invite-fragment.ts` makes the decision, and its test covers it. |
| `src/app/oauth/electron-bridge/` | Hands the OIDC callback to the `app.hachiman://oauth-callback` deep link. |
| `src/app/api/oidc/[...path]/` | Adapts Next.js requests to the panva `oidc-provider` callback. |
| `src/app/api/auth/[...nextauth]/` | Auth.js handlers for the dashboard cookie session. |
| `src/app/api/regions/` | Public region list with probe endpoints. |
| `src/app/api/v1/` | REST API (contract §4): guilds, channels, messages, roles, members, invites, users, uploads, files, limits, region recommendation. |
| `src/middleware.ts` | CORS for `/api/*`, except `/api/v1/uploads`. |
| `src/auth.ts` | Auth.js: Drizzle adapter, email and password credentials, JWT sessions. |
| `src/lib/auth-helpers.ts` | `requireUser()`: accepts the Auth.js cookie or an OIDC bearer token. |
| `src/lib/oidc-provider.ts` | Lazy panva `Provider` singleton and its configuration. |
| `src/lib/oidc-adapter.ts` | panva storage on Drizzle. Clients come from the `oidc_clients` table. |
| `src/lib/oidc-interaction.ts` | Bridges `next/headers` to the panva interaction API. |
| `src/lib/guild-access.ts` | Loads membership, roles and overwrites, and computes permissions with `@hachiman/client/permissions`. Also `publishToChannel()`. |
| `src/lib/guilds.ts`, `invites.ts` | Guild read models and invite logic. |
| `src/lib/invite-limits.ts` | Invite limits (contract §4): only an administrator makes an invite that is permanent, lasts longer than 24 hours, or has history. A route that takes ADMINISTRATOR away revokes the permanent invites and the invites with history of that user in its transaction, and publishes `INVITE_DELETE`. |
| `src/lib/invite-history.ts` | Invites with history (contract §12.11.4, §12.12): the record checks of `POST /guilds/:id/invites`, the member list of records, and the store of the sealed bundles (only for the groups in the scope of the record) with its caps (1 MiB per sender user other than the creator, 4 MiB per invite) and its sweep. The storage seam `InviteHistoryStore` has a Drizzle and an in-memory implementation (`invite-history.in-memory.ts`). `invite-history.conformance.ts` runs on both. |
| `src/lib/wire.ts` | Converts DB rows to wire shapes (contract §1). No DB access. |
| `src/lib/events.ts` | Redis client and the `publishToGuild()` / `publishToUser()` publishers (contract §5). |
| `src/lib/uploads.ts` | Upload claims (image or attachment) and attachment row deletion. |
| `src/lib/files.ts` | Pure helpers: limits, keys, content type, `Content-Disposition`, byte ranges. |
| `src/lib/storage.ts` | S3 client: put, get stream, delete. |
| `src/lib/placement.ts` | Pure RTT-based region scorer for `/api/v1/regions/recommend`. |
| `src/lib/allowed-origins.ts`, `cors.ts` | The CORS allowlist and its headers. |
| `src/lib/session-revocation.ts` | Rejects Auth.js cookies of deleted users or cookies older than the Redis cut-off. |
| `src/db/` | Drizzle `schema.ts`, `client.ts`, and the `migrate`, `seed` and `revoke-sessions` scripts. Migrations are in `drizzle/`. |
| `src/grpc/main.ts`, `server.ts` | gRPC process entry point and server. It binds loopback by default. |
| `src/grpc/proto.ts` | Loads `apps/hachiman-server/pkg/management/management.proto` with `@grpc/proto-loader`. |
| `src/grpc/media-nodes.ts` | `RegisterMediaNode` and `MediaNodeHeartbeat` handlers. |
| `src/grpc/placement.ts` | `PlaceMediaSession` handler: least-loaded fresh node in the region. |
| `src/grpc/repo.ts`, `repo.in-memory.ts` | `MediaNodesRepo`: Drizzle implementation and the test implementation. |
| `src/grpc/mls-scheduler.ts` | The MLS batch scheduler (a timer and `takusen:mls_wakeup`) and the daily DS sweeps: old handshakes, inbox items, link sessions, join requests, group epochs, page media, the bundles of ended invites, and suite upgrades. Contract §12.7.5, §12.7.9, §12.11.4, §12.15. |
| `src/grpc/kt-heads.ts` | The 10 s timer that signs key transparency tree heads and publishes `KT_TREE_HEAD`. Only this process signs heads. Contract §12.14. |
| `src/app/api/v1/devices/`, `mls/`, `backups/`, `kt/` | The E2EE routes of contract §12.12. `users/[id]/keys`, `master-key`, `device-signing-key` and `channels/[id]/mls-group` are E2EE routes too. Each one is a thin `dsRoute()` wrapper around `lib/mls`. The invite history routes (`guilds/[id]/invite-records`, `invite-records/`, `invites/[code]/bundles`) call `lib/invite-history.ts`. |
| `src/lib/mls/` | The delivery service. See "The delivery service" below. |
| `src/lib/errors.ts`, `api-helpers.ts` | Domain errors and `ApiError(code, status, message?, extra?, retryAfterSec?)`. `errorResponse()` maps them to `{ error, message?, ...extra }` and sets `Retry-After`. |

### Flow: a REST mutation

`POST /api/v1/channels/:id/messages` shows the pattern that each mutation follows.

```mermaid
sequenceDiagram
  participant C as Client
  participant H as api/v1 handler
  participant A as auth-helpers
  participant GA as guild-access
  participant DB as Postgres
  participant EV as lib/events
  participant R as Redis

  C->>H: POST with Bearer token
  H->>A: requireUser()
  A-->>H: session or 401
  H->>GA: loadChannelAccess(), requirePermission()
  GA->>DB: member, roles, overwrites
  GA-->>H: permissions or 403
  H->>DB: transaction: insert message, claim uploads
  DB-->>H: commit
  H->>EV: publishToChannel(MESSAGE_CREATE)
  EV->>R: PUBLISH guild:{id} with channelId
  H-->>C: 200 Message
```

## The delivery service (`src/lib/mls/`)

Contract §12.7 and §12.18. The DS orders and checks the MLS handshakes of the `public_set`, `channel` and `dm` groups. It never makes a commit, because the author of a commit can read the group. It never decrypts a message: it reads only the envelope header.

| File | What |
|---|---|
| `repo.ts`, `repo.drizzle.ts`, `repo.in-memory.ts` | `MlsRepo`, the storage seam. One method per behavior. Change the two implementations in the same commit. |
| `readers.ts` | `channelReaders`, `isPublicChannel`, `groupReaders` (§12.6). The one Takusen implementation, on `@hachiman/client/permissions`. |
| `device-auth.ts`, `device-binding.ts` | `requireDevice`: the `X-Hachiman-Device` check of the D routes. The first device that an OIDC grant names is bound to that grant (Redis `takusen:grant_device:{grantId}`). After that, the bearer token can claim only that device. A revoked device's grants and tokens are deleted after the commit. |
| `membership.ts` | `onMembershipChange` and `wakeScheduler`, the seams for the content routes. They queue Removes and Adds, allocate and retire groups, and move channels between groups. |
| `commits.ts` | The commit upload: `DsModule.checkCommit` for checks 2-7, then the database checks, the policy table, the compare-and-set on the epoch, and the writes (§12.7.3). The policy takes the external join of a user without a leaf into a `channel` group only with a valid `InviteAuth` of a redeemer: the stored record of the invite, the scope, the invite state and the 24 h after the guild join with the invite (§12.11.4, `MlsRepo.getInviteByKeyId`, `inviteJoinedBy`). |
| `proposals.ts` | One signed DS proposal per pending item and epoch, appended to the handshake stream before a batch uses it (§12.7.4). |
| `batches.ts` | The scheduler step: committer choice, batch assignment, timeout, decline, the `external_commit` and `waiting` fallbacks (§12.7.5, §12.7.7). |
| `groups.ts`, `reconcile.ts`, `joins.ts`, `key-packages.ts` | Group allocation and `POST /mls/groups` checks, Add and Remove queueing, join requests, key package upload and claim. |
| `identity.ts`, `kt.ts` | Devices, master keys, DSK certs, revocation, `UserKeys`, and key transparency (appends under `pg_advisory_xact_lock`, proofs, head signing). |
| `envelopes.ts` | `acceptEnvelope`: the envelope header checks on send and edit (§12.8.4). |
| `device-data.ts` | Handshake reads, the device inbox, backups, history bundles and device linking. |
| `keys.ts`, `config.ts`, `context.ts` | The DS and KT seed files (exclusive create, mode 0600, then a read), the env config, and the production dependencies (`dsDeps()`). |
| `crypto.ts`, `crypto-ds.d.ts` | The one import point of `@hachiman/crypto`. Takusen uses `@hachiman/crypto/ds`, which holds no group secrets. |
| `events.ts`, `route.ts` | The outbox of E2EE events, and the `dsRoute()` handler wrapper. |
| `wire-format.ts`, `bytes.ts`, `shapes.ts` | The framings that the DS reads itself, strict base64url, and the `Wire*` shapes. |
| `testing.ts` | Test support: `FakeDs` (fake MLS objects, real identity and KT code) and a world builder. Production code does not import it. |

Rules:

- A route that changes DS state collects its events in an `Outbox`. `dsRoute()` publishes the outbox after the handler returns, so no event describes a write that rolled back.
- A content route calls `onMembershipChange(tx, change, actorDeviceId)` in its transaction, after its write. After the commit, it calls `wakeScheduler(tx)`. `wakeScheduler` signs the new proposals, publishes them, and wakes the gRPC process.
- Every writer of a group's epoch or proposals locks the group row first (`MlsRepo.lockGroup`). The commit compare-and-set takes the same lock. Thus a proposal is never signed twice for one epoch.
- The services take `(repo, deps, out, …)`. The tests run the same services on `InMemoryMlsRepo` with `FakeDs`, so they need no Postgres and no Redis.

## Pages (`src/lib/docs/`)

Contract §4 Pages and §12.20. A `pages` channel holds a tree of pages. The content of a page is a Yjs document that only members can decrypt, so Takusen cannot merge edits. It stores the page tree, an ordered log of encrypted updates, and pointers to encrypted snapshots.

| File | What |
|---|---|
| `repo.ts`, `repo.drizzle.ts`, `repo.in-memory.ts` | `DocsRepo`, the storage seam. `repo.conformance.ts` is one suite for both implementations. Change the two implementations in the same commit. |
| `service.ts` | Create, move (cycle check), delete; the update log (`seq` from `doc_pages.latest_seq` under a row lock); the snapshot compare-and-set and the pointer re-wrap (the same `baseSeq` and `uploadId` in a newer epoch: the row changes in place, with no claim, quota change or delete); the title compare-and-set (`ifUpdatedAt`, 409 `PageConflict`); the page heads (`GET /channels/:id/pages/heads`); media claims; the guild quota (`guilds.page_storage_bytes`). |
| `access.ts`, `wire.ts`, `config.ts` | The channel and permission checks of the routes, the zod bodies and wire shapes, and the limits. |
| `../mls/envelopes.ts` | `acceptDocEnvelope`: the page envelope header checks. It shares the group, epoch and sender checks with `acceptEnvelope`. |
| `../page-media-sweep.ts` | The daily sweep of page media that no kept snapshot lists. |
| `../channel-types.ts` | `TEXT_GROUP_TYPES`: `text` and `pages` use a text MLS group. |

Storage: Postgres holds rows of bounded size (the tree, update envelopes up to 32 KiB, pointer envelopes). The snapshot bytes and page media are encrypted S3 objects in `uploads` (purposes `page_snapshot` and `page_media`, column `page_id`). A page keeps at most two snapshots. `DOC_UPDATE` is published to `guild:{id}` after the commit, as other events are.

A new member of the group of a pages channel cannot open the envelopes of older epochs. The members re-wrap the newest snapshot pointer and the title of each page in the new epoch (contract §12.20 "Access by new members"). Takusen stores the header group and epoch of each snapshot, so the re-wrap rule needs no schema change. The heads route decodes only the header of each title envelope.

## Conventions

### Publish after commit

Call the `lib/events.ts` publishers after the DB transaction commits, never inside it. On a publish failure, the publisher writes a log and the request still succeeds, because the DB already holds the mutation. A new gateway event also needs changes in the contract, the client types and the gateway. See the root `CLAUDE.md`.

### Upload claims

- An upload has no purpose until a claim sets it. The first claim wins.
- `claimImage()` sets `image`. A later `claimImage()` can use the same image upload again.
- `claimForMessage()` sets `attachment`. No later claim can use an attachment upload.
- Run each claim in the transaction that stores the reference.
- A page snapshot upload has purpose `page_snapshot` from the upload on, and gets its `page_id` from the snapshot claim. `claimPageMedia` sets `page_media` and refreshes `last_referenced_at`. Page claims count toward `guilds.page_storage_bytes`.
- To delete a message, channel or guild, call `deleteAttachmentRows()` in the transaction. Then call `deleteObjects()` with the keys after the commit.

### MediaNodesRepo lockstep

All gRPC handlers get to `media_nodes` through `MediaNodesRepo` in `src/grpc/repo.ts`. When you add a method, change `drizzleMediaNodesRepo` and `InMemoryMediaNodesRepo` in the same change. Do not write `media_nodes` SQL outside `repo.ts`.

### gRPC security posture

The management RPCs have no application-layer auth. Thus the server binds `127.0.0.1` by default. `TAKUSEN_GRPC_BIND_ADDR` sets a different host and port, and the server then logs a warning. With an external bind, you must isolate the network yourself.

## Run, test, build

Run from the repo root. `pnpm dev:takusen` is the same as `pnpm -F @hachiman/takusen dev`.

```bash
pnpm -F @hachiman/takusen dev          # Next.js on :3000 and the gRPC process
pnpm -F @hachiman/takusen dev:next     # Next.js only
pnpm -F @hachiman/takusen dev:grpc     # gRPC process only
pnpm -F @hachiman/takusen build        # next build
pnpm -F @hachiman/takusen start        # next start
pnpm -F @hachiman/takusen start:grpc   # gRPC process (production)
pnpm -F @hachiman/takusen typecheck    # tsgo
pnpm -F @hachiman/takusen test         # every src/**/*.test.ts on node --test with the tsx loader, no DB, no Redis
pnpm -F @hachiman/takusen test:canary  # the E2EE canary against a running test deployment (below)
pnpm -F @hachiman/takusen test:pg      # the src/**/*.pg.test.ts suites on Postgres; need TAKUSEN_PG_TEST_URL (below)
pnpm -F @hachiman/takusen lint
pnpm -F @hachiman/takusen format

pnpm -F @hachiman/takusen db:generate      # drizzle-kit: new migration from schema.ts
pnpm -F @hachiman/takusen db:migrate
pnpm -F @hachiman/takusen db:seed          # regions and the hachiman-client OIDC client
pnpm -F @hachiman/takusen db:studio
pnpm -F @hachiman/takusen sessions:revoke  # sign out all users
```

The MlsRepo conformance suite (`src/lib/mls/repo.conformance.ts`) is one test suite for both MlsRepo implementations. `pnpm test` runs it on `InMemoryMlsRepo` (`repo.in-memory.test.ts`). `repo.drizzle.pg.test.ts` runs it on `drizzleMlsRepo` and a real Postgres, but only when `TAKUSEN_PG_TEST_URL` is set. Otherwise it skips, so `pnpm test` needs no database. Use a separate test database. The suite refuses the database `takusen`, because it writes rows that it does not delete. `src/lib/invite-limits.pg.test.ts` uses the same rules for the SQL of the invite limits (the revoke of admin invites and `createInvite`), and `src/lib/invite-history.pg.test.ts` runs the InviteHistoryStore conformance suite on `drizzleInviteHistoryStore`. `test:pg` runs all three. To run them against the Docker Postgres (use the user of your container):

```bash
docker exec hachiman-postgres psql -U takusen -d postgres -c 'CREATE DATABASE hachiman_e2ee_test'   # once
cd apps/takusen
DATABASE_URL=postgres://takusen:takusen@localhost:5432/hachiman_e2ee_test pnpm db:migrate
TAKUSEN_PG_TEST_URL=postgres://takusen:takusen@localhost:5432/hachiman_e2ee_test pnpm test:pg
```

When the schema changes, run `db:migrate` on the test database again.

The E2EE canary (`src/e2ee/canary.integration.ts`) needs a running test deployment: Takusen, its gRPC process and the gateway. Two headless clients sign in, send a unique string in a DM, a private channel and a public channel, and decrypt it. Then the script searches every Postgres column, S3 object, Redis key and Redis command, and every client frame for that string. Run it only against a test database, because it creates users and guilds:

```bash
CANARY_BASE_URL=http://localhost:3100 CANARY_GATEWAY_URL=ws://localhost:8180/gateway \
  node --env-file=<test env file> --import tsx src/e2ee/canary.integration.ts   # from apps/takusen
```

Each schema change gets a new migration: edit `src/db/schema.ts`, run `pnpm db:generate`, and commit the new file in `drizzle/` and `drizzle/meta/`. Do not edit or regenerate a committed migration. `db:migrate` applies the new migrations to a database that has data.

### Environment

All processes read the repo-root `.env`. Copy it from [`.env.example`](../../.env.example), which documents each variable. Do not put env files in `apps/takusen`, because Next.js loads them first and they shadow the root file.

| Group | Variables |
|---|---|
| Shared | `DATABASE_URL`, `REDIS_URL` |
| Object storage | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
| Auth and OIDC | `AUTH_SECRET`, `NEXTAUTH_URL`, `OIDC_ISSUER_URL`, `OIDC_COOKIES_KEY`, `OIDC_JWKS_JSON` (production) |
| HTTP | `TAKUSEN_ALLOWED_ORIGINS`, `HACHIMAN_WEB_URL`, `TAKUSEN_MAX_UPLOAD_BYTES` |
| Seed | `HACHIMAN_CLIENT_REDIRECT_URIS` |
| Dev | `TAKUSEN_NEXT_DIST_DIR` (default `.next`): give a second `next dev` in the same checkout its own directory, for example `.next-2` |
| gRPC | `TAKUSEN_GRPC_PORT`, `TAKUSEN_GRPC_BIND_ADDR` (production) |
| E2EE delivery service | `TAKUSEN_DS_SIGNING_KEY`, `TAKUSEN_KT_SIGNING_KEY`, `TAKUSEN_MLS_SUITES`, `TAKUSEN_MAX_ENVELOPE_BYTES`, `TAKUSEN_PUBLIC_SET_MAX_MEMBERS`, `TAKUSEN_MLS_BATCH_INTERVAL_MS`, `TAKUSEN_MLS_BATCH_TIMEOUT_MS` |

The DS and KT seed paths are relative to `apps/takusen`. When a seed file is missing, the first process that needs it creates it. A deployment with more than one Takusen instance must share the two seed files.
