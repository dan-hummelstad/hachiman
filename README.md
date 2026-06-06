# Hachiman

Mumble voice chat infrastructure — a modern client, library, and server in a single monorepo.

Hachiman provides a desktop application for Mumble voice communication, a TypeScript client library for building Mumble-compatible applications, and an extended Mumble server with WebRTC support for browser clients. An optional control plane ([`apps/oracle`](apps/oracle/)) layers multi-tenant managed hosting on top — self-hosted deployments work unchanged.

---

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) >= 18
- [pnpm](https://pnpm.io/) >= 10
- [Go](https://go.dev/) >= 1.25 (for the server)
- [Docker](https://www.docker.com/) + Docker Compose (only for managed mode — Postgres + Redis)
- [OpenSSL](https://www.openssl.org/) (only for generating Oracle secrets in managed mode)

### Install

```bash
pnpm install
```

That's it for the self-hosted stack — jump to **Development → Self-host** below.

### Managed-mode setup (optional)

Only needed if you're running the Oracle control plane locally. Skip otherwise.

**1. Start Postgres + Redis**

```bash
docker-compose -f docker/docker-compose.yml up -d postgres redis
```

| Service  | Image            | Port   | Credentials                                    |
|----------|------------------|--------|------------------------------------------------|
| Postgres | `postgres:17`    | `5432` | user `oracle` · password `oracle` · db `oracle` |
| Redis    | `redis:7-alpine` | `6379` | (no auth)                                      |

Postgres is persisted in a `postgres_data` Docker volume; Redis is intentionally volumeless (live metrics are transient). On first init, the Postgres container also runs [`docker/init.sql`](docker/init.sql), which creates a **`grumble` schema** alongside the default `public` schema — Oracle's Drizzle tables live in `public`, and Grumble's GORM tables live under `grumble.*` so the two systems can share one database without colliding on table names (`servers`, `users`, …).

**2. Configure Oracle**

```bash
cp apps/oracle/.env.example apps/oracle/.env

openssl rand -base64 32    # → AUTH_SECRET
openssl rand -base64 32    # → OIDC_COOKIES_KEY
openssl rand -base64 32    # → TAKUSEN_INVITE_SIGNING_KEY
```

For the managed-server creation flow, also set in `.env`:

```env
TAKUSEN_MANAGED_GATEWAY_HOST=localhost
TAKUSEN_MANAGED_GATEWAY_GRPC=127.0.0.1:50051
```

The defaults already match the docker-compose Postgres (`DATABASE_URL=postgres://oracle:oracle@localhost:5432/oracle`) and the dev OIDC issuer (`OIDC_ISSUER_URL=http://localhost:3000/api/oidc` — must end with `/api/oidc` for OIDC discovery to resolve).

**3. Apply the schema + seed**

```bash
pnpm -F @hachiman/oracle db:migrate    # apply the Drizzle schema
pnpm -F @hachiman/oracle db:seed       # 4 regions + hachiman-client OIDC client
```

The seed inserts only what's needed to bootstrap:
- **4 regions**: `us-east`, `us-west`, `eu-west`, `ap-southeast`.
- The **`hachiman-client`** OIDC client with the dev redirect URIs (`app.hachiman://oauth-callback`, `http://localhost:3000/oauth/electron-bridge`, `http://localhost:5173|5174/oauth/callback`).

No fixture islands, vServers, or users — create them through the dashboard when you need them.

---

## Development

### Self-host

The default, zero-config path: a single Grumble process + SQLite, no control plane.

```bash
pnpm dev          # everything in parallel (server + apps) with hot-reload
```

Or run pieces individually:

```bash
pnpm dev:server     # Go server with nodemon hot-reload
pnpm dev:electron   # Electron desktop app
pnpm dev:browser    # Browser app on Vite (http://localhost:5173)
```

The server listens on port **64738** (TCP, UDP, and WebSocket share the port). Hosts connect with self-signed certificates generated at runtime.

### Managed mode

Run Oracle + a managed-mode Grumble alongside the client apps. Assumes you've already completed **Setup → Managed-mode setup**.

**1. Start Oracle**

```bash
pnpm dev:oracle    # Next.js on http://localhost:3000
```

Open <http://localhost:3000> and sign up — the first account is yours.

**2. Start a managed-mode Grumble**

In a separate terminal:

```bash
DATABASE_DRIVER=postgres \
DATABASE_DSN="postgres://oracle:oracle@localhost:5432/oracle?sslmode=disable&search_path=grumble" \
MANAGEMENT_LISTEN=127.0.0.1:50051 \
pnpm dev:server
```

> **`search_path=grumble` is required.** It tells Postgres to put Grumble's `servers`/`users`/etc. in the `grumble` schema instead of `public` (where Oracle already owns those table names). Without it, Grumble's first AutoMigrate fails with `there is no unique constraint matching given keys for referenced table "servers"`.

This Grumble process now:

| Port              | What                                                          |
|-------------------|---------------------------------------------------------------|
| `:64738` TCP/UDP/WS | Mumble (clients connect here)                                 |
| `127.0.0.1:50051` | Internal gRPC management API (loopback-only, no auth)         |

All managed-mode env vars are gated on non-empty values — unset any of them and the server reverts to self-host behaviour (SQLite at `apps/hachiman-server/bin/data/murmur.sqlite`, no gRPC port).

**3. Create a managed server in the dashboard**

In Oracle (<http://localhost:3000>), open **Servers → New server** and pick **Managed by Takusen**:

| Field         | Value                                              |
|---------------|----------------------------------------------------|
| **Name**      | anything (e.g. `Test`)                             |
| **Slug**      | URL-safe (e.g. `test`)                             |
| **Region**    | `us-east` (or any seeded region)                    |
| **Description** | optional                                           |

Host (`localhost`) and port (`64738`) are stamped server-side from `TAKUSEN_MANAGED_GATEWAY_HOST`. On submit, Oracle issues a `CreateVirtualServer` gRPC call to the Grumble at `TAKUSEN_MANAGED_GATEWAY_GRPC`, which allocates a fresh in-process vServer and stamps the creator's Oracle user id as `AdminOracleUserID` (the owner-grant path in `handleAuthenticate`). The whole call is inside Oracle's DB transaction, so a gRPC failure rolls back the registry row — no orphan rows. The OIDC client secret is shown once; copy it.

**4. Connect a client**

```bash
pnpm dev:electron      # Electron desktop (auto-accepts the self-signed cert in dev)
# or
pnpm dev:browser       # Browser app on http://localhost:5173
```

Sign in with Oracle (PKCE) — your created server appears in the server list and connects with one click.

**Optional: enable the Redis metrics publisher** (for the future scheduler). Create an island row in Postgres, then start Grumble with:

```bash
DATABASE_DRIVER=postgres \
DATABASE_DSN="postgres://oracle:oracle@localhost:5432/oracle?sslmode=disable&search_path=grumble" \
MANAGEMENT_LISTEN=127.0.0.1:50051 \
ISLAND_METRICS_REDIS_URL=redis://localhost:6379 \
ISLAND_METRICS_ISLAND_ID=<island-uuid> \
pnpm dev:server
```

Without these, Grumble simply doesn't publish metrics — managed-server creation still works.

### Returning to self-host

Stop Grumble, unset the managed-mode env vars, and run `pnpm dev:server` again — it reverts to local SQLite at `apps/hachiman-server/bin/data/murmur.sqlite` and opens no Redis connection or gRPC port. Oracle and the docker-compose stack can be left running independently.

### Troubleshooting

**`no unique constraint matching given keys for referenced table "servers"` on first Grumble start** — Grumble's AutoMigrate is landing tables in `public` instead of `grumble`, colliding with Oracle's same-named tables.

1. **DSN missing `search_path=grumble`** (most common). Switch to the URL-form DSN above (`postgres://...?sslmode=disable&search_path=grumble`) and restart Grumble. Polluted tables in `public` from the failed attempt are orphaned but harmless.

2. **Postgres volume was created before `docker/init.sql` existed.** Wipe and re-bootstrap:

   ```bash
   docker-compose -f docker/docker-compose.yml down -v
   docker-compose -f docker/docker-compose.yml up -d postgres redis
   pnpm -F @hachiman/oracle db:migrate
   pnpm -F @hachiman/oracle db:seed
   ```

### TypeScript: `tsgo`, not `tsc`

All TypeScript work in this repo uses the [TypeScript-native compiler](https://github.com/microsoft/typescript-go) (`@typescript/native-preview`, binary `tsgo`), installed once as a root devDependency. Every workspace's `typecheck` and `build` script invokes `tsgo` directly — do not run `tsc` or add `typescript` as a devDependency to any package.

```bash
pnpm -F @hachiman/hachiman          typecheck
pnpm -F @hachiman/hachiman-electron typecheck
pnpm -F @hachiman/hachiman-browser  typecheck
pnpm -F @hachiman/oracle            typecheck
```

---

## Build

```bash
# Server binary
pnpm build:server

# Browser bundle (Vite)
pnpm build:browser

# Desktop app
pnpm build:electron

# Or installers for a specific platform:
cd apps/hachiman-electron
pnpm build:mac       # macOS
pnpm build:win       # Windows
pnpm build:linux     # Linux (AppImage, snap, deb)
```

---

## Deployment

**TBD.** Production deployment guidance for the managed stack is in progress. The intended shape:

- **Self-hosted Grumble** — drop the built binary on a host, point clients at it. Already works.
- **Managed (Oracle + islands)** — k3s island pods + lifecycle, HAProxy L4 config generated from the control plane, regional DNS SRV registration, wake proxy as the scale-to-zero front door, centralised auth webhook.

The current roadmap and per-component status lives in [`docs/managed-platform-and-latency-changes.md`](docs/managed-platform-and-latency-changes.md). Architectural contracts (intended shape, not yet deployed):

| Topic                                                | Doc                                                                       |
|------------------------------------------------------|---------------------------------------------------------------------------|
| Region → island → vServer layering, re-home flow     | [`apps/oracle/REGION-CONTRACT.md`](apps/oracle/REGION-CONTRACT.md)        |
| Region scorer (tolerance bands, weights)             | [`apps/oracle/PLACEMENT-DESIGN.md`](apps/oracle/PLACEMENT-DESIGN.md)      |
| Islands + scheduler + lifecycle                      | [`apps/oracle/ISLAND-PLATFORM.md`](apps/oracle/ISLAND-PLATFORM.md)        |
| Internal Grumble gRPC + operator contract            | [`apps/oracle/MANAGEMENT-API.md`](apps/oracle/MANAGEMENT-API.md)          |
| Redis island metrics (keys, TTL, publish cadence)    | [`apps/oracle/ISLAND-METRICS.md`](apps/oracle/ISLAND-METRICS.md)          |
| Thin & on-path relay invariants                      | [`apps/hachiman-server/THIN-RELAY-DESIGN.md`](apps/hachiman-server/THIN-RELAY-DESIGN.md) |

---

## Packages

| Package | Description | Tech |
|---------|-------------|------|
| [`apps/hachiman`](apps/hachiman/) | Shared React UI library (components, stores, services, platform abstraction) | React 19, Tailwind CSS 4, Zustand |
| [`apps/hachiman-electron`](apps/hachiman-electron/) | Electron desktop host | electron-vite, native TLS + Opus |
| [`apps/hachiman-browser`](apps/hachiman-browser/) | Browser host | Vite, WebSocket + WebRTC |
| [`apps/hachiman-server`](apps/hachiman-server/) | Mumble-compatible voice server | Go, Pion WebRTC, SQLite |
| [`apps/oracle`](apps/oracle/) | Optional control plane (auth, registry, OIDC provider, scheduler) | Next.js, Drizzle, Postgres |
| [`pkgs/hachiman-node`](pkgs/hachiman-node/) | TypeScript Mumble client library | RxJS, Protobuf, WebRTC |

The host apps (`hachiman-electron`, `hachiman-browser`) both depend on the shared UI in `@hachiman/hachiman` and the protocol/transport library in `@hachiman/hachiman-node`. The shared UI talks to Mumble through the `IMumbleService` / `IPlatformService` interfaces; each host provides its own implementation under `platforms/<host>/`.

---

## Architecture

```mermaid
graph TB
    subgraph Clients
        E[Electron App]
        B[Browser Client]
    end

    subgraph "hachiman-node library"
        TLS[TlsTransport]
        WS[WsTransport]
        MS[MumbleSocket]
        CM[Channel Manager]
        UM[User Manager]
        WV[WebRTCVoice]
        TLS --> MS
        WS --> MS
        MS --> CM
        MS --> UM
    end

    subgraph "hachiman-server"
        TCP[TCP/TLS Listener]
        UDP[UDP Listener]
        WSL[WebSocket Listener]
        HL[Handler Loop]
        SFU[WebRTC SFU]
        VB[Voice Broadcast]
        TCP --> HL
        WSL --> HL
        UDP --> VB
        HL --> VB
        SFU --> VB
    end

    E --> TLS
    B --> WS
    B --> WV
    WV -.->|SDP/ICE via control channel| MS
    WV <-.->|RTP audio| SFU
    TLS -->|TCP/TLS :64738| TCP
    WS -->|WebSocket :64738| WSL
    E -->|UDP :64738| UDP
```

### Connection flows

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant SFU as WebRTC SFU

    Note over C,S: TCP/TLS Handshake
    C->>S: Version (1.4.287)
    S->>C: Version
    C->>S: Authenticate (username, password, tokens, webrtc?)
    S->>C: CryptSetup (encryption keys)
    S->>C: ChannelState (for each channel)
    S->>C: UserState (for each connected user)
    S->>C: ServerSync (session ID)
    S->>C: ServerConfig

    alt WebRTC enabled
        S->>SFU: AddClient (create PeerConnection)
        SFU->>S: SDP Offer
        S->>C: WebRTC (SDP offer)
        C->>S: WebRTC (SDP answer)
        S->>SFU: HandleAnswer
        C->>S: IceCandidate
        S->>SFU: AddICECandidate
        Note over C,SFU: RTP audio flows directly
    else Native UDP
        C->>S: Encrypted UDP voice packets
        S->>C: Encrypted UDP voice packets
    end

    loop Every 10s
        C->>S: Ping
        S->>C: Ping
    end
```

### Voice routing

The server bridges audio between native UDP clients and WebRTC browser clients transparently:

```mermaid
flowchart LR
    subgraph Native Clients
        NC1[Client A - UDP]
        NC2[Client B - UDP]
    end

    subgraph Server
        VB[Voice Broadcast]
        SFU[SFU]
        SSRC[SSRC Pool]
        SSRC --> SFU
    end

    subgraph Browser Clients
        BC1[Client C - WebRTC]
        BC2[Client D - WebRTC]
    end

    NC1 -->|Encrypted UDP| VB
    VB -->|Encrypted UDP| NC2
    VB -->|RTP via SFU| BC1
    VB -->|RTP via SFU| BC2
    BC1 -->|RTP| SFU --> VB
```

### Electron app architecture

```mermaid
graph TB
    subgraph "Main Process"
        MW[Main Window]
        IPC[IPC Handlers]
    end

    subgraph "Renderer Process"
        App[App.tsx]

        subgraph Stores
            SS[serverStore]
            CS[channelStore]
            MS2[messageStore]
            US[userStore]
            VS[voiceStore]
        end

        subgraph Services
            SV[ServersService]
            CV[ChannelsService]
            VV[VoiceService]
        end

        subgraph Components
            SB[AppSidebar]
            CH[ChatHistory]
            MT[MessageToolbar]
            VC[VoiceControls]
        end

        Services --> Stores
        Components --> Stores
        App --> Components
    end

    subgraph "Platform Layer (@platform)"
        direction LR
        PE["platforms/electron/\n(TLS + Opus)"]
        PB["platforms/browser/\n(WebSocket + WebRTC)"]
    end

    Services --> PE
    Services --> PB
    IPC <--> App

    PE --> LIB["@hachiman/hachiman-node"]
    PB --> LIB
```

### Managed multi-tenant hosting

On top of the protocol stack, Hachiman ships a control plane ([`apps/oracle`](apps/oracle/)) that places and lifecycles managed Mumble servers ("**vServers**") across a fleet of Grumble processes ("**islands**"). Self-hosted servers keep working unchanged — every managed config key is gated on a non-empty value, so leaving them empty returns the original single-process SQLite behaviour.

```mermaid
graph TB
    subgraph Users
        U[Dashboard user]
        MC[Mumble client]
    end

    subgraph "Oracle control plane (apps/oracle)"
        DASH[Next.js dashboard + API]
        SCHED["Scheduler<br/>region scorer → island bin-pack"]
        DASH --> SCHED
    end

    subgraph "Shared state"
        PG[("Postgres<br/>regions · servers · islands · virtual_servers")]
        RDS[("Redis<br/>island:&lt;id&gt;:metrics (HSET + TTL)")]
    end

    subgraph "Region: us-east"
        subgraph "Island A — Grumble process"
            MGMTA["gRPC mgmt<br/>(loopback)"]
            VSA["vServer 17<br/>vServer 42"]
            PUBA[Metrics publisher]
        end
        subgraph "Island B — Grumble process"
            MGMTB["gRPC mgmt<br/>(loopback)"]
            VSB[vServer 88]
            PUBB[Metrics publisher]
        end
    end

    subgraph "Region: eu-west"
        subgraph "Island C — Grumble process"
            MGMTC["gRPC mgmt<br/>(loopback)"]
            VSC[vServer 9]
            PUBC[Metrics publisher]
        end
    end

    U -->|HTTPS| DASH
    SCHED -->|read metrics| RDS
    SCHED <-->|read / write state| PG
    SCHED -.->|"CreateVirtualServer<br/>DeleteVirtualServer"| MGMTA
    SCHED -.->|gRPC| MGMTB
    SCHED -.->|gRPC| MGMTC
    MGMTA --> VSA
    MGMTB --> VSB
    MGMTC --> VSC
    VSA <-->|GORM| PG
    VSB <-->|GORM| PG
    VSC <-->|GORM| PG
    PUBA -.->|"HSET + EXPIRE<br/>(every tick)"| RDS
    PUBB -.-> RDS
    PUBC -.-> RDS
    MC -->|"Mumble TLS/UDP :64738"| VSA
```

Dotted arrows are gRPC (`CreateVirtualServer` / `DeleteVirtualServer`) and the Redis metric publish; solid arrows are normal request/DB traffic. The Mumble client only ever talks to the island hosting its vServer — Oracle is never on the voice path.

End-to-end placement loop on `CreateServer`:

| Step | Where | What |
|------|-------|------|
| 1 | Oracle scheduler | Reads live per-island metrics from **Redis** (`island:{id}:metrics`) |
| 2 | Oracle scheduler | Bin-packs across `active` islands in the target region (`fill*0.5 + cpu*0.3 + bw*0.2`) |
| 3 | Oracle | Calls **`CreateVirtualServer`** on the chosen island's Grumble over **gRPC** (`127.0.0.1`-only, loopback-enforced) |
| 4 | Grumble | `ServerAdd` in central **Postgres**, boots the vServer in-process, registers it in the in-memory registry |
| 5 | Grumble publisher | Next tick `HSET`s the updated island metrics back to **Redis** (with TTL) |
| 6 | Next placement | Sees the new load — the loop is closed |

---

## Client library

`@hachiman/hachiman-node` can be used independently to build Mumble-compatible applications:

```typescript
import { Client } from '@hachiman/hachiman-node'

const client = new Client({
  host: 'localhost',
  port: 64738,
  username: 'bot',
  rejectUnauthorized: false,
})

await client.connect()

// List channels
for (const channel of client.channels.all()) {
  console.log(channel.name)
}

// Join a channel
const lobby = client.channels.byName('Lobby')
await client.self.moveToChannel(lobby.id)

// Send a text message
await client.command('textMessage', {
  sendPacket: [TextMessage, { message: 'Hello!', channelId: [lobby.id] }],
  expectPacket: [TextMessage, () => true],
})

// Listen for events
client.on('userCreate', (user) => console.log(`${user.name} connected`))
client.on('speakingStateChange', ({ user, speaking }) => {
  console.log(`${user.name} ${speaking ? 'started' : 'stopped'} speaking`)
})

client.disconnect()
```

### Browser usage

For browser clients, use WebSocket transport with WebRTC voice:

```typescript
const client = new Client({
  host: 'server.example.com',
  port: 64738,
  username: 'browser-user',
  transport: 'websocket',
  wsUrl: 'ws://server.example.com:64738/',
  webrtc: true,
})

await client.connect()
client.webrtcVoice?.startMicrophone()
```

---

## Protocol

Hachiman implements the [Mumble protocol](https://mumble-protocol.readthedocs.io/) with extensions for WebRTC:

| Type | Message | Description |
|------|---------|-------------|
| 0 | Version | Client/server version exchange |
| 2 | Authenticate | Username, password, tokens, WebRTC flag |
| 5 | ServerSync | Session assignment, welcome text |
| 7 | ChannelState | Channel create/update |
| 9 | UserState | User state changes |
| 11 | TextMessage | Chat messages |
| 27 | WebRTC | SDP offer/answer exchange |
| 28 | IceCandidate | ICE candidate exchange |
| 29 | TalkingState | Voice activity for WebRTC clients |

---

## Project structure

```
hachiman/
├── apps/
│   ├── hachiman/                       # Shared React UI library (@hachiman/hachiman)
│   │   └── src/
│   │       ├── App.tsx                 # Root layout (server rail + channel sidebar + chat + members)
│   │       ├── components/             # UI (shadcn/ui + custom: chat-area, channel-sidebar, member-list, …)
│   │       ├── services/               # ServersService, ChannelsService, VoiceService, MessagesService
│   │       ├── stores/                 # Zustand stores (server, channel, message, user, voice)
│   │       └── shared/                 # IMumbleService, IPlatformService, PlatformContext
│   │
│   ├── hachiman-electron/              # Electron host (@hachiman/hachiman-electron)
│   │   ├── src/
│   │   │   ├── main/                   # Electron main process
│   │   │   ├── preload/                # IPC bridge
│   │   │   └── renderer/src/           # Mounts the shared <App />
│   │   └── platforms/electron/         # MumbleService (TLS + Opus), PlatformService
│   │
│   ├── hachiman-browser/               # Browser host (@hachiman/hachiman-browser)
│   │   └── src/
│   │       ├── main.tsx                # Mounts the shared <App />
│   │       └── platforms/browser/      # MumbleService (WebSocket + WebRTC), PlatformService
│   │
│   ├── hachiman-server/                # Go Mumble server (Grumble fork)
│   │   ├── cmd/grumble/                # Server entry point + packet handlers + voice broadcast
│   │   └── pkg/
│   │       ├── web/                    # WebRTC SFU + SSRC pool
│   │       ├── mumbleproto/            # Protobuf definitions (authoritative for both sides)
│   │       ├── database/               # GORM + SQLite/Postgres
│   │       ├── management/             # Internal gRPC API (loopback-only)
│   │       ├── acl/                    # Permission system
│   │       └── cryptstate/             # Voice encryption
│   │
│   └── oracle/                         # Control plane (@hachiman/oracle)
│       └── src/                        # Next.js dashboard + API + Drizzle schema + OIDC provider
│
└── pkgs/
    └── hachiman-node/                  # Mumble client library (@hachiman/hachiman-node)
        └── src/
            ├── client.ts               # Main client API
            ├── transport.ts            # ITransport interface
            ├── tls-transport.ts        # Node.js TLS
            ├── ws-transport.ts         # Browser WebSocket
            ├── webrtc-voice.ts         # WebRTC voice
            ├── mumble-socket.ts        # Protocol framing
            └── mumbleproto/            # Generated protobuf bindings (do not edit by hand)
```

See [`CLAUDE.md`](CLAUDE.md) for repo conventions (Zustand selector patterns, the `tsgo`-only rule, protobuf regeneration workflow, etc.).

---

## License

ISC
