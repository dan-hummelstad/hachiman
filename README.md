# Hachiman

Guild-based voice and text chat with a Discord-style architecture. Guilds are Postgres rows, not processes.
Clients use a REST API for reads, writes and files, a WebSocket gateway for realtime events, and WebRTC for voice and screen share.

Everything is end-to-end encrypted (E2EE): DMs, guild text channels, attachments, voice, video and screen share. There is no plaintext mode.
Key agreement uses MLS (RFC 9420, through ts-mls). Each device is a separate MLS member. Media frames use SFrame.

Takusen, the gateway and the media nodes relay only ciphertext. They see metadata: membership, sender, time, sizes, typing, presence and voice state.
They also see the read state, pinned message ids, guild events, thread names, blocks and custom status.
Avatars, guild icons and banners stay plaintext, because they are public profile data.

The Electron app is the strong client. The browser app shows the label "trusts the server's code", because a hostile server can send hostile JavaScript to a browser.

The wire contract for every process boundary is [`docs/gateway-protocol.md`](docs/gateway-protocol.md). §12 of it is normative for E2EE.
The decisions behind the design are in [`docs/discord-refactor.md`](docs/discord-refactor.md) and, for E2EE, in [`docs/e2ee-plan.md`](docs/e2ee-plan.md).
The UI spec is in [`docs/ui-redesign.md`](docs/ui-redesign.md).
Repo conventions are in [`CLAUDE.md`](CLAUDE.md).

## Packages

Each package README has its own diagrams: where the package fits, its code architecture and its key flows.

| Path | Package | What |
|---|---|---|
| [`apps/takusen`](apps/takusen/README.md) | `@hachiman/takusen` | Next.js app: identity (OIDC provider), REST API `/api/v1`, encrypted file blobs (S3), Postgres schema (Drizzle), Redis event publisher. The E2EE delivery service: devices, key packages, MLS groups, handshakes, device inbox, key transparency. A separate process serves the management gRPC (media registry + placement) and runs the MLS batch scheduler. |
| [`apps/hachiman-server`](apps/hachiman-server/README.md) | `hachiman-server` | Go: `hachiman-gateway` (WebSocket gateway, device-scoped delivery), `hachiman-media` (WebRTC SFU for voice and screen share, voice E2EE relay and commit ordering), `hachiman-recorder` (scaffold, not wired). |
| [`pkgs/hachiman-client`](pkgs/hachiman-client/README.md) | `@hachiman/client` | Browser-safe client library: `RestClient`, `GatewayClient`, `VoiceConnection`, `HachimanClient`, permissions, upload policy, wire types. It holds no crypto. |
| [`pkgs/hachiman-crypto`](pkgs/hachiman-crypto/README.md) | `@hachiman/crypto` | E2EE: the crypto Worker (identity, MLS groups, envelopes, attachments, encrypted store) and the SFrame transform Worker. Takusen checks MLS uploads with the `./ds` entry. |
| [`apps/hachiman`](apps/hachiman/README.md) | `@hachiman/hachiman` | Shared React UI (components, Zustand stores, services, hooks, the `IPlatformService` seam, a `?preview` mode with no backend). `CryptoService` owns the crypto Worker. |
| [`apps/hachiman-electron`](apps/hachiman-electron/README.md) | `@hachiman/hachiman-electron` | Electron host: CSP, deep links, region probe, screen source picker, the wrap key in the OS keychain (`safeStorage`), `hachiman://app` renderer protocol. |
| [`apps/hachiman-browser`](apps/hachiman-browser/README.md) | `@hachiman/hachiman-browser` | Browser host (Vite): the same CSP, a non-extractable wrap key in IndexedDB. |

## Architecture

### Components

```mermaid
flowchart LR
  subgraph Hosts
    direction TB
    subgraph E[Electron host]
      EM["main<br/>CSP, deep links, region probe,<br/>screen picker, safeStorage wrap key"]
      ER["renderer<br/>shared UI + @hachiman/client"]
      EW["crypto Worker<br/>@hachiman/crypto: keys, MLS,<br/>envelopes, IndexedDB store"]
      ET["transform Worker<br/>SFrame, one per call"]
      EM <-- "preload IPC: probes, wrap key" --> ER
      ER <-- "RPC: CryptoApi, DsTransport" --> EW
      EW -- "frame keys (MessagePort)" --> ET
      ER -- "RTCRtpScriptTransform" --> ET
    end
    BR["Browser host<br/>shared UI + the same two Workers<br/>trusts the server's code"]
  end

  subgraph Takusen
    O["Next.js :3000<br/>OIDC + REST /api/v1<br/>encrypted blobs, E2EE DS, KT"]
    OG["gRPC Management<br/>127.0.0.1:50051<br/>+ MLS batch scheduler, KT heads"]
  end

  G[hachiman-gateway x N<br/>WS /gateway :8080]
  M[hachiman-media x N<br/>WS /voice :8090<br/>WebRTC SFU, E2EE relay]
  PG[(Postgres)]
  R[(Redis)]
  S3[(S3<br/>SeaweedFS in dev)]
  T[coturn<br/>optional]

  ER & BR -- HTTPS REST + blobs --> O
  ER & BR -- WSS gateway --> G
  ER & BR -- "WSS voice + SRTP (SFrame)" --> M
  ER & BR -. TURN relay .-> T
  T -.-> M
  P[region probe hosts]
  ER -- GET /api/regions --> O
  EM -- TCP RTT probe --> P

  O -- read/write --> PG
  O -- put/get objects --> S3
  O -- "PUBLISH guild:* / user:* / device:*" --> R
  OG -- "media_nodes, mls_*" --> PG
  OG -- "PUBLISH MLS_BATCH_ASSIGN, KT_TREE_HEAD" --> R

  G -- "READY load, devices,<br/>media_nodes.signaling_url" --> PG
  G -- "sessions, resume buffer, device_online,<br/>presence, voice state, PSUBSCRIBE" --> R
  G -- GET /api/v1/users/@me --> O
  G -- PlaceMediaSession --> OG
  G -- PUBLISH media:nodeId kick --> R

  M -- Register / Heartbeat --> OG
  M -- SUBSCRIBE media:nodeId --> R
```

Gateway and media nodes are stateless. Durable data lives in Postgres. File bytes live in S3, and only Takusen talks to the bucket. Sessions, the resume buffer, presence, voice state and the event bus live in Redis.

All key material lives in the crypto Worker of each device. The UI thread gets only status, decrypted content and attachment pointers. The Worker never calls `fetch`. It asks the UI thread for each REST call (`DsTransport`). The wrap key of the Worker store comes from the host (`IPlatformService.secureStorage`).

The gateway and media nodes have no direct link. The gateway signs a voice token for one media node and can kick a session through the Redis channel `media:{nodeId}`. The gateway mints TURN credentials (`TURN_SECRET`, `TURN_URLS`) when they are configured. Otherwise clients get a public STUN server.

### Connection and event flow

```mermaid
sequenceDiagram
  participant W as Crypto Worker
  participant C as Client (UI thread)
  participant O as Takusen
  participant S3 as S3
  participant PG as Postgres
  participant R as Redis
  participant G as Gateway

  C->>O: OIDC PKCE sign-in (client hachiman-client)
  O-->>C: access token
  C->>W: init (wrap key from secureStorage)
  opt first sign-in on this device
    W->>O: POST /api/v1/devices, PUT certificate, POST key packages (through C)
  end
  W-->>C: deviceId
  C->>G: connect /gateway
  G-->>C: HELLO {heartbeatInterval}
  C->>G: IDENTIFY {token, deviceId, capabilities: [e2ee/1], clientVersion}
  G->>O: GET /api/v1/users/@me (Bearer token)
  O-->>G: User
  G->>PG: devices row (else close 4013), load guilds, channels, roles, members
  G->>R: HSET session:{id}, SET device_online:{deviceId}, SET presence:{userId}
  G-->>C: DISPATCH READY {sessionId, deviceId, ...}

  Note over W,G: Send: encrypt in the Worker, then REST
  opt message with files
    C->>W: encrypt attachment
    W-->>C: encrypted blob + pointer
    C->>O: POST /api/v1/uploads?kind=blob (raw body)
    O->>S3: PutObject
    O-->>C: Attachment {id}
  end
  C->>W: encryptMessage(channelId, content, pointers)
  W-->>C: envelope
  C->>O: POST /api/v1/channels/:id/messages {envelope, nonce, attachments: [id]}
  O->>PG: envelope checks, insert message + claim uploads, commit
  O->>R: PUBLISH guild:{id} {t: MESSAGE_CREATE, d, channelId}
  R-->>G: pattern message (every node)
  G->>R: append to events:{sessionId} (resume buffer)
  G-->>C: DISPATCH MESSAGE_CREATE (sessions with VIEW_CHANNEL only)
  C->>W: decryptMessages
  W-->>C: content, then messagesStore

  Note over W,G: Group changes (MLS)
  O->>R: PUBLISH device:{committer} MLS_BATCH_ASSIGN
  G-->>C: DISPATCH MLS_BATCH_ASSIGN (sessions of that device only)
  C->>W: gateway event
  W->>O: POST /api/v1/mls/groups/:groupId/commits (through C)
  O->>R: PUBLISH guild:{id} MLS_HANDSHAKE, device:{joiner} DEVICE_INBOX (Welcome)
  G-->>C: DISPATCH MLS_HANDSHAKE (every member device)
  C->>W: gateway event (process the commit, new epoch)

  Note over C,G: Reconnect
  C->>G: RESUME {token, sessionId, seq, deviceId}
  G->>R: replay events:{sessionId} after seq
  G-->>C: missed DISPATCH frames, RESUMED
  Note over W,G: The Worker fetches missed handshakes by seq over REST, not from the resume buffer
```

The gateway closes with 4012 when IDENTIFY has no `e2ee/1` capability or the client version is too old. It closes with 4013 when the device is unknown or revoked. The client does not reconnect after either code. After 4013, the app signs out.

### Voice join and screen share

```mermaid
sequenceDiagram
  participant W as Crypto Worker
  participant C as Client
  participant G as Gateway
  participant R as Redis
  participant OG as Takusen gRPC
  participant PG as Postgres
  participant M as Media node
  participant P as Committer (another member)

  C->>G: op 4 VOICE_STATE_UPDATE {guildId, channelId, selfMute, selfDeaf, selfStream}
  G->>G: check CONNECT + VIEW_CHANNEL
  G->>R: HSET voice:{guildId}, SET voice_user:{userId}
  G->>R: PUBLISH guild:{id} VOICE_STATE_UPDATE
  Note over G: Only mute / deaf / stream changed: stop here
  G->>R: GET voice_room:{channelId}
  alt no node yet
    G->>OG: PlaceMediaSession {channelId, guildId, homeRegion}
    OG-->>G: {nodeId, signalingUrl}
    G->>R: SET NX voice_room:{channelId} (loser uses the winner's node)
  else node known
    G->>PG: SELECT signaling_url FROM media_nodes
  end
  opt session was on another channel or node
    G->>R: PUBLISH media:{oldNodeId} kick
  end
  G-->>C: VOICE_SERVER_UPDATE {endpoint, token (with deviceId), iceServers, expiresAt}
  C->>W: voiceStart (key package for the voice group)
  C->>M: identify {token, e2ee: {version: 1, keyPackage}}
  M-->>C: ready, peers, e2ee_roster {committer, members, pending}
  M-->>C: offer {sdp} (media is always the offerer)
  C->>M: answer {sdp}, candidates

  Note over C,P: Join the voice MLS group
  M->>P: e2ee_key_package (the joiner)
  P->>M: e2ee_commit {epoch, commit, welcome}, then e2ee_ratchet_tree
  M->>M: first commit for the room epoch wins
  M-->>C: e2ee_welcome, e2ee_ratchet_tree
  M-->>P: e2ee_prepare_transition (to every member)
  C->>W: process the Welcome
  C->>M: e2ee_ready {transitionId, epoch, leafIndex}
  M-->>C: e2ee_execute_transition (all ready, or after 3 s)
  W-->>C: frame keys to the transform Worker (MessagePort)
  C-->>M: WebRTC: mic (Opus) + screen slot (VP8), SFrame payloads
  M-->>C: each peer's tracks: userId (mic), screen-userId (screen)

  Note over C,M: Screen share
  C->>C: replaceTrack on the screen sender (no renegotiation, same transform)
  C->>G: op 4 {selfStream: true}
  G->>R: PUBLISH VOICE_STATE_UPDATE (peers show the stream)
```

The gateway signs the voice token (PASETO v4.public, `pkg/voicetoken`) for one media node. The media node verifies it and rejects a replayed token id.

Each voice room session has its own MLS group. The media node has no MLS library. It relays key packages, Welcomes, commits and ratchet trees, and it accepts the first commit for each epoch. The committer is the member with the lowest leaf index. The SFU forwards the SFrame payloads unchanged. The UI shows the call participants from the MLS tree, not from the server roster.

### Pages: edits and presence

A `pages` channel shows chat in the center and a tree of collaborative markdown pages on the right. The clients merge edits with Yjs. The server stores and relays only page envelopes (contract §4 Pages, §12.20).

```mermaid
sequenceDiagram
    participant A as Client A (editor)
    participant W as Crypto Worker
    participant T as Takusen
    participant S3 as S3
    participant R as Redis
    participant G as Gateway
    participant B as Client B

    Note over A: open page: GET /pages/:id/state
    A->>T: GET state
    T-->>A: snapshot pointer + updates after baseSeq
    A->>S3: (via Takusen /files) snapshot blob
    A->>W: decryptDoc + decryptAttachment
    Note over A: Y.applyUpdate

    Note over A: typing (batched 100 ms)
    A->>W: encryptDoc(doc_update)
    A->>T: POST /pages/:id/updates {envelope}
    T->>T: acceptDocEnvelope, seq = latest_seq + 1
    T->>R: PUBLISH guild:{id} DOC_UPDATE
    R->>G: DOC_UPDATE (ephemeral: no seq, no resume buffer)
    G->>B: DOC_UPDATE (VIEW_CHANNEL filter)
    B->>B: decryptDoc, Y.applyUpdate, seq gap -> GET updates?after=

    Note over A: cursor moves
    A->>G: op 5 DOC_AWARENESS {envelope}
    G->>R: PUBLISH guild:{id} DOC_AWARENESS (view, type, 8 KiB, 20/s)
    R->>G: DOC_AWARENESS
    G->>B: DOC_AWARENESS

    Note over A: > 200 updates, or a new epoch
    A->>S3: (via POST /uploads?kind=page_snapshot) encrypted state
    A->>T: POST /pages/:id/snapshots {baseSeq, uploadId, envelope}
    T->>T: compare-and-set, keep previous, delete older + their objects
```

### Shared UI

```mermaid
flowchart LR
  subgraph Host
    PS[PlatformService<br/>implements IPlatformService]
  end

  HC["HachimanClient<br/>(@hachiman/client)<br/>rest + gateway + voice + cache"]
  H[services/hachiman.ts<br/>singleton + event mirror]
  TS[TakusenService<br/>PKCE, token refresh]
  CS["CryptoService<br/>one CryptoClient"]
  CW["crypto Worker<br/>(@hachiman/crypto)"]
  MD[message-decrypt<br/>decrypt before store]
  S[MessagesService · VoiceService<br/>InviteService · UploadService<br/>AdminActionService]
  FS[UnreadService<br/>guild-features: pins, events,<br/>threads, blocks, custom status]
  SND[SoundService<br/>event chimes]
  ST[Zustand stores<br/>guild, channel, messages, voice,<br/>user, takusen, prefs, limits,<br/>nav, dialog, docs, tabs, composer,<br/>unread, pins, events, threads]
  CST[cryptoStore<br/>status, alerts, membership,<br/>voice roster]
  UI[components<br/>shell: sidebar, tab bar, content card,<br/>right column · chat, voice, people,<br/>settings, inbox, events, threads,<br/>pins, notify, docs, security]

  PS -- beginOAuth, onOAuthCallback --> TS
  PS -- secureStorage wrap key --> CS
  PS -- PlatformContext: regions, screen sources,<br/>invite links, title bar --> UI
  TS -- getAccessToken --> HC
  HC -- update / events --> H
  H -- MLS_*, DEVICE_*, USER_KEYS_UPDATE --> CS
  H -- MESSAGE_* --> MD
  CS <-- RPC --> CW
  CW -- DsTransport --> HC
  MD -- decryptMessages --> CS
  MD -- upsert --> ST
  CS -- events --> CST
  H -- setState --> ST
  H -- events --> SND
  S -- own actions --> SND
  S -- calls --> HC
  S -- encrypt, sign --> CS
  S -- setState --> ST
  ST -- prefs --> SND
  ST -- selectors --> UI
  CST -- selectors --> UI
  UI -- actions --> S
  UI -- actions --> FS
  H -- "READY, READ_STATE_UPDATE,<br/>CHANNEL_PINS_UPDATE, MESSAGE_CREATE" --> FS
  FS -- calls --> HC
  FS -- decrypt --> MD
  FS -- setState --> ST
```

`services/hachiman.ts` owns the one `HachimanClient` and copies its cache into the stores after each event. Components read stores. They write through the services or `hachiman.rest`. The gateway event that results then updates the stores.

`UnreadService` keeps the read state and counts the mentions on the client, because the server cannot read them. Reactions are encrypted messages with their own content kind. `SoundService` plays a chime for message, voice and stream events, as `prefsStore` permits.

The shell is one sidebar (280 px) and one content card on a wallpaper that the guild tints. The top of the sidebar holds the controls, the space bar, the quick switcher and the favourite DMs. Below them are the channel list (or the settings sections) and the voice dock. The space bar replaces the guild rail. A pinned tab bar runs above the content card. The right column shows the members, a page or a DM profile. The UI spec is [`docs/ui-redesign.md`](docs/ui-redesign.md).

`CryptoService` owns the one `CryptoClient`, which is the crypto Worker of the signed-in user. `services/hachiman.ts` forwards the E2EE gateway events to it. The client cache holds ciphertext. Every message goes through the Worker before it goes into `messagesStore`. `cryptoStore` mirrors the Worker events and holds no key material.

Each host implements `IPlatformService` (`apps/hachiman/src/shared/IPlatformService.ts`). It supplies the OAuth redirect URI and sign-in flow, the title-bar inset, invite deep links, OAuth callbacks, region probes and the screen source picker. It also supplies the store wrap key (`secureStorage`). The Electron implementation (`apps/hachiman-electron/src/renderer/src/PlatformService.ts`) wraps the preload bridge `window.hachiman`. The browser implementation (`apps/hachiman-browser/src/platforms/browser/PlatformService.ts`) does same-tab redirects, gives no region probe and uses the browser's own screen picker.

## Local development

Prerequisites: Node 22.9+, pnpm 10+, Go 1.25+, Docker.

```bash
pnpm install

# 1. Postgres (:5432), Redis (:6379) and SeaweedFS (S3 on :8333, bucket hachiman-uploads)
docker compose -f docker/docker-compose.yml up -d

# 2. One env file for all services, at the repo root.
#    Set AUTH_SECRET and OIDC_COOKIES_KEY (openssl rand -base64 32).
#    The values for DATABASE_URL, REDIS_URL, S3_* and OIDC_ISSUER_URL match the compose file.
#    For voice, set MEDIA_REGION=us-east (a seeded region).
cp .env.example .env

# 3. Schema + seed (OIDC client hachiman-client, regions)
pnpm db:migrate && pnpm db:seed

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
3. Set up encryption on the device. Keep the recovery key that the app shows.
4. Create a guild.
5. Set the guild region to `us-east`.

To work on the UI without a backend, open the browser host with `?preview`. Stubbed REST and gateway data and a crypto stub then drive the UI (see [`apps/hachiman/src/dev/README.md`](apps/hachiman/src/dev/README.md)).

Environment: every runner reads the repo-root `.env` (Takusen, gateway, media and the Vite builds). `.env.example` lists all variables, in one section for each service. A "Production only" section holds the JWKS, the gRPC bind address, TURN and the voice public key. A variable that you set in your shell wins over the file. If the file does not exist, each runner uses its defaults.

E2EE variables: Takusen reads `TAKUSEN_DS_SIGNING_KEY` and `TAKUSEN_KT_SIGNING_KEY` (seed files that it creates when they do not exist), plus the MLS and envelope limits `TAKUSEN_MLS_*`, `TAKUSEN_MAX_ENVELOPE_BYTES` and `TAKUSEN_PUBLIC_SET_MAX_MEMBERS`. The gateway reads `GATEWAY_MIN_CLIENT_VERSION`. Media reads `MEDIA_WS_READ_LIMIT`. `.env.example` gives the defaults.

Full setup notes: [`docs/takusen-sso-setup.md`](docs/takusen-sso-setup.md). Server flags: [`apps/hachiman-server/README.md`](apps/hachiman-server/README.md). Placement design: [`apps/takusen/PLACEMENT-DESIGN.md`](apps/takusen/PLACEMENT-DESIGN.md).

Schema changes: each change adds a migration (`pnpm -F @hachiman/takusen db:generate`), and `pnpm db:migrate` applies it. Do not edit or regenerate a committed migration. `pnpm db:reset` empties the dev DB, then migrates and seeds. There is no migration from plaintext data.

## Checks

```bash
pnpm -F @hachiman/hachiman typecheck
pnpm -F @hachiman/hachiman-electron typecheck
pnpm -F @hachiman/hachiman-browser typecheck
pnpm -F @hachiman/client typecheck
pnpm -F @hachiman/crypto typecheck
pnpm -F @hachiman/takusen typecheck

pnpm -F @hachiman/client test
pnpm -F @hachiman/crypto test
pnpm -F @hachiman/takusen test
pnpm -F @hachiman/hachiman-electron test
pnpm -F @hachiman/hachiman-browser test
cd apps/hachiman-server && CGO_ENABLED=0 go test ./...
```

TypeScript uses `tsgo` (`@typescript/native-preview`), not `tsc`.

The shared UI unit tests run with the vitest binary of a sibling package: `cd apps/hachiman && ../../pkgs/hachiman-client/node_modules/.bin/vitest run --config src/dev/vitest.config.ts`.

## Build

```bash
pnpm build:server        # bin/hachiman-gateway, bin/hachiman-media (the recorder builds only from its Dockerfile)
pnpm build:browser
pnpm build:electron      # or: pnpm -F @hachiman/hachiman-electron build:mac | build:win | build:linux
```

Docker images: `apps/hachiman-server/Dockerfile.{gateway,media,recorder}` (plus `Dockerfile.arm32v6.*`). Each image builds one binary.

A production browser deployment must send the CSP as a response header on every response, Worker scripts included. The meta tag in the build does not cover Workers. See [`apps/hachiman-browser/README.md`](apps/hachiman-browser/README.md).

## License

ISC. `apps/hachiman-server` and `pkgs/hachiman-client` keep their upstream licenses. See the `LICENSE` file in each.
