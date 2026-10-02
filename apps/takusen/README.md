# Takusen

Takusen is the identity provider and the REST API of Hachiman. It owns the Postgres schema, stores file bytes in S3 and publishes gateway events to Redis. A separate gRPC process keeps the media node registry and places voice sessions.

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
  N -- "PUBLISH guild:{id}, user:{id}" --> RD
  RD -- "PSUBSCRIBE" --> G
  N -- "S3 API: put, get, delete" --> S3
```

- **Host apps → Takusen (OIDC).** The apps sign in with Authorization Code + PKCE against `/api/oidc` as the public client `hachiman-client`. Electron gets the callback through `/oauth/electron-bridge`. See [`docs/takusen-sso-setup.md`](../../docs/takusen-sso-setup.md).
- **Host apps → Takusen (REST).** The apps call `/api/v1` with the access token as a bearer token. Uploads and downloads also go through Takusen, so clients never touch the bucket. Contract §4.
- **Electron main → Takusen.** The main process reads the public `GET /api/regions` and probes each region for RTT. A client can then send the RTTs to `POST /api/v1/regions/recommend`. See [`PLACEMENT-DESIGN.md`](PLACEMENT-DESIGN.md).
- **Gateway → Takusen (REST).** At IDENTIFY, the gateway calls `GET /api/v1/users/@me` to check the token. The gateway reads Postgres directly for READY.
- **Gateway → Takusen (gRPC).** The gateway calls `PlaceMediaSession` when a voice channel has no media node. Contract §9.
- **Media → Takusen (gRPC).** Each media node calls `RegisterMediaNode` at start and `MediaNodeHeartbeat` at an interval. Contract §9.
- **Takusen → Redis.** After each REST mutation commits, Takusen publishes the gateway event on `guild:{id}` or `user:{id}`. Each gateway node subscribes. Contract §5.
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
  GL["lib/guilds.ts, invites.ts"]
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
| `src/app/invite/[code]/` | Public invite preview page. It links to `HACHIMAN_WEB_URL`. |
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

## Conventions

### Publish after commit

Call the `lib/events.ts` publishers after the DB transaction commits, never inside it. On a publish failure, the publisher writes a log and the request still succeeds, because the DB already holds the mutation. A new gateway event also needs changes in the contract, the client types and the gateway. See the root `CLAUDE.md`.

### Upload claims

- An upload has no purpose until a claim sets it. The first claim wins.
- `claimImage()` sets `image`. A later `claimImage()` can use the same image upload again.
- `claimForMessage()` sets `attachment`. No later claim can use an attachment upload.
- Run each claim in the transaction that stores the reference.
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
pnpm -F @hachiman/takusen test         # tsx unit tests and gRPC handler tests, no DB
pnpm -F @hachiman/takusen lint
pnpm -F @hachiman/takusen format

pnpm -F @hachiman/takusen db:generate      # drizzle-kit: new migration from schema.ts
pnpm -F @hachiman/takusen db:migrate
pnpm -F @hachiman/takusen db:seed          # regions and the hachiman-client OIDC client
pnpm -F @hachiman/takusen db:studio
pnpm -F @hachiman/takusen sessions:revoke  # sign out all users
```

The schema still changes. Do not add ALTER migrations to a dev DB. Drop the schema, then run `db:migrate` and `db:seed` again.

### Environment

All processes read the repo-root `.env`. Copy it from [`.env.example`](../../.env.example), which documents each variable. Do not put env files in `apps/takusen`, because Next.js loads them first and they shadow the root file.

| Group | Variables |
|---|---|
| Shared | `DATABASE_URL`, `REDIS_URL` |
| Object storage | `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
| Auth and OIDC | `AUTH_SECRET`, `NEXTAUTH_URL`, `OIDC_ISSUER_URL`, `OIDC_COOKIES_KEY`, `OIDC_JWKS_JSON` (production) |
| HTTP | `TAKUSEN_ALLOWED_ORIGINS`, `HACHIMAN_WEB_URL`, `TAKUSEN_MAX_UPLOAD_BYTES` |
| Seed | `HACHIMAN_CLIENT_REDIRECT_URIS` |
| gRPC | `TAKUSEN_GRPC_PORT`, `TAKUSEN_GRPC_BIND_ADDR` (production) |
