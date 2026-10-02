# Hachiman

Guild-based voice and text chat with a Discord-style architecture. Guilds are Postgres rows, not processes.
Clients use a REST API for reads and writes, a WebSocket gateway for realtime events, and WebRTC for voice.

The wire contract for every process boundary is [`docs/gateway-protocol.md`](docs/gateway-protocol.md).
The decisions behind the design are in [`docs/discord-refactor.md`](docs/discord-refactor.md).
Repo conventions are in [`CLAUDE.md`](CLAUDE.md).

## Packages

| Path | Package | What |
|---|---|---|
| `apps/takusen` | `@hachiman/takusen` | Next.js app: identity (OIDC), REST API `/api/v1`, Postgres schema (Drizzle), Redis event publisher. A separate process serves the management gRPC (media registry + placement). |
| `apps/hachiman-server` | `hachiman-server` | Go: `hachiman-gateway` (WebSocket gateway), `hachiman-media` (WebRTC SFU), `hachiman-recorder` (scaffold). |
| `pkgs/hachiman-client` | `@hachiman/client` | Browser-safe client library: `RestClient`, `GatewayClient`, `VoiceConnection`, `HachimanClient`. |
| `apps/hachiman` | `@hachiman/hachiman` | Shared React UI (components, Zustand stores, services). |
| `apps/hachiman-electron` | `@hachiman/hachiman-electron` | Electron host. |
| `apps/hachiman-browser` | `@hachiman/hachiman-browser` | Browser host (Vite). |

## Architecture

### Components

```mermaid
flowchart LR
  subgraph Clients
    E[Electron host]
    B[Browser host]
  end
  subgraph Takusen
    O[Next.js<br/>OIDC + REST /api/v1]
    OG[gRPC Management<br/>127.0.0.1:50051]
  end
  G[hachiman-gateway x N<br/>WS /gateway]
  M[hachiman-media x N<br/>WS /voice + WebRTC]
  PG[(Postgres)]
  R[(Redis)]

  E & B -- HTTPS REST --> O
  E & B -- WSS gateway --> G
  E & B -- WSS voice + SRTP --> M
  O -- read/write --> PG
  O -- PUBLISH guild:* / user:* --> R
  OG -- media_nodes --> PG
  G -- read --> PG
  G -- sessions, presence, voice state, PSUBSCRIBE --> R
  G -- GET /api/v1/users/@me --> O
  G -- PlaceMediaSession --> OG
  G -- PUBLISH media:nodeId kick --> R
  M -- Register / Heartbeat --> OG
  M -- SUBSCRIBE media:nodeId --> R
```

Gateway and media nodes are stateless. Durable data lives in Postgres. Sessions, presence, voice state and the event bus live in Redis.

### Connection and event flow

```mermaid
sequenceDiagram
  participant C as Client
  participant O as Takusen
  participant PG as Postgres
  participant R as Redis
  participant G as Gateway

  C->>O: OIDC PKCE sign-in (client hachiman-client)
  O-->>C: access token
  C->>G: connect /gateway
  G-->>C: HELLO {heartbeatInterval}
  C->>G: IDENTIFY {token}
  G->>O: GET /api/v1/users/@me (Bearer token)
  O-->>G: User
  G->>PG: load guilds, channels, roles, members
  G-->>C: DISPATCH READY

  Note over C,G: Mutations go through REST
  C->>O: POST /api/v1/channels/:id/messages
  O->>PG: insert + commit
  O->>R: PUBLISH guild:{id} {t: MESSAGE_CREATE, d, channelId}
  R-->>G: pattern message (every node)
  G-->>C: DISPATCH MESSAGE_CREATE (sessions with VIEW_CHANNEL only)
```

### Voice join

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Gateway
  participant R as Redis
  participant OG as Takusen gRPC
  participant M as Media node

  C->>G: op 4 VOICE_STATE_UPDATE {guildId, channelId}
  G->>R: HSET voice:{guildId}, PUBLISH VOICE_STATE_UPDATE
  G->>R: GET voice_room:{channelId}
  alt no node yet
    G->>OG: PlaceMediaSession {channelId, guildId, homeRegion}
    OG-->>G: {nodeId, signalingUrl}
    G->>R: SET NX voice_room:{channelId}
  end
  G-->>C: VOICE_SERVER_UPDATE {endpoint, token, iceServers}
  C->>M: connect endpoint (/voice), identify {token}
  M-->>C: ready {sessionId, ssrc}
  M-->>C: peers [{userId, ssrc}]
  M-->>C: offer {sdp}
  C->>M: answer {sdp}, candidates
  C-->>M: WebRTC (Opus over SRTP)
```

The gateway signs the voice token (PASETO, `pkg/voicetoken`) for one media node. The media node verifies it. There is no gateway-to-media link except the Redis kick channel.

### Shared UI

```mermaid
flowchart LR
  HC["HachimanClient<br/>(@hachiman/client)<br/>rest + gateway + cache"]
  OS[TakusenService<br/>PKCE, token refresh]
  H[services/hachiman.ts<br/>singleton + event mirror]
  S[MessagesService<br/>VoiceService<br/>InviteService]
  ST[Zustand stores<br/>guild, channel, messages,<br/>voice, user, takusen]
  UI[components]

  OS -- getAccessToken --> HC
  HC -- update / events --> H
  H -- setState --> ST
  S -- calls --> HC
  S -- setState --> ST
  ST -- selectors --> UI
  UI -- actions --> S
```

`services/hachiman.ts` owns the one `HachimanClient` and copies its cache into the stores after each event. Components read stores. They write through the services or `hachiman.rest`. The gateway event that results then updates the stores.

Hosts implement `IPlatformService` (`apps/hachiman/src/shared/IPlatformService.ts`): the OAuth redirect URI and sign-in page, the title-bar inset, invite deep links, OAuth callbacks and region probes.

## Local development

Prerequisites: Node 22.9+, pnpm 10+, Go 1.25+, Docker.

```bash
pnpm install

# 1. Postgres, Redis and SeaweedFS (S3 on :8333)
docker compose -f docker/docker-compose.yml up -d

# 2. One env file for all services, at the repo root.
#    Set AUTH_SECRET and OIDC_COOKIES_KEY (openssl rand -base64 32).
#    The values for DATABASE_URL, REDIS_URL and OIDC_ISSUER_URL match the compose file.
#    For voice, set MEDIA_REGION=us-east (a seeded region).
cp .env.example .env

# 3. Schema + seed (OIDC client hachiman-client, regions)
pnpm -F @hachiman/takusen db:migrate && pnpm -F @hachiman/takusen db:seed

# 4. Takusen: Next.js on :3000 and the management gRPC on 127.0.0.1:50051 (one command starts both)
pnpm dev:takusen

# 5. Gateway (:8080) + media (:8090). Both read the root .env.
#    Takusen places voice by guild region. Run media in a seeded region and give the guild that region.
pnpm dev:server          # or pnpm dev:gateway / pnpm dev:media

# 6. A host app
pnpm dev:browser         # http://localhost:5173
pnpm dev:electron
```

When the stack runs, do these steps:

1. Create an account at http://localhost:3000/signup.
2. Sign in from the app.
3. Create a guild.
4. Set the guild region to `us-east`.

Environment: every runner reads the repo-root `.env` (Takusen, gateway, media and the Vite builds). `.env.example` lists all variables, in one section for each service. A variable that you set in your shell wins over the file. If the file does not exist, each runner uses its defaults.

Full setup notes: [`docs/takusen-sso-setup.md`](docs/takusen-sso-setup.md). Server flags: [`apps/hachiman-server/README.md`](apps/hachiman-server/README.md).

Schema changes during development: drop the dev DB schema. Then run `db:migrate` + `db:seed` again. Do not stack ALTERs.

## Checks

```bash
pnpm -F @hachiman/hachiman typecheck
pnpm -F @hachiman/hachiman-electron typecheck
pnpm -F @hachiman/hachiman-browser typecheck
pnpm -F @hachiman/client typecheck
pnpm -F @hachiman/takusen typecheck

pnpm -F @hachiman/client test
pnpm -F @hachiman/takusen test
pnpm -F @hachiman/hachiman-electron test
cd apps/hachiman-server && CGO_ENABLED=0 go test ./...
```

TypeScript uses `tsgo` (`@typescript/native-preview`), not `tsc`.

## Build

```bash
pnpm build:server        # bin/hachiman-gateway, bin/hachiman-media
pnpm build:browser
pnpm build:electron      # or: pnpm -F @hachiman/hachiman-electron build:mac | build:win | build:linux
```

Docker images: `apps/hachiman-server/Dockerfile.{gateway,media,recorder}` (plus `Dockerfile.arm32v6.*`).

## License

ISC. `apps/hachiman-server` and `pkgs/hachiman-client` keep their upstream licenses. See the `LICENSE` file in each.
