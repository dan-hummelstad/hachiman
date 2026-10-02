# hachiman-server

Go module `hachiman/server`. It holds the realtime processes of Hachiman: the WebSocket gateway, the WebRTC media node and a recorder scaffold.
Takusen (`apps/takusen`) owns auth, the REST API and the Postgres schema. The wire contract is [`docs/gateway-protocol.md`](../../docs/gateway-protocol.md).

## Where it fits

```mermaid
flowchart LR
  C["Clients<br/>@hachiman/client"]
  TR["Takusen REST<br/>:3000 /api/v1"]
  TG["Takusen gRPC<br/>127.0.0.1:50051"]
  PG[("Postgres")]
  R[("Redis")]
  TURN["coturn"]

  subgraph server["hachiman-server"]
    GW["hachiman-gateway<br/>:8080 /gateway"]
    MD["hachiman-media<br/>:8090 /voice"]
    RC["hachiman-recorder<br/>scaffold"]
  end

  C -- "WS: ops + dispatch" --> GW
  C -- "WS: SDP/ICE, peers, speaking" --> MD
  C -- "UDP: RTP / DTLS-SRTP" --> MD
  C -. "TURN relay" .-> TURN
  GW -- "HTTP: GET /users/@me" --> TR
  GW -- "gRPC: PlaceMediaSession" --> TG
  MD -- "gRPC: Register + Heartbeat" --> TG
  GW -- "SQL: READY, media_nodes" --> PG
  TR -- "PUBLISH guild:* user:*" --> R
  GW -- "PSUBSCRIBE, keys, PUBLISH media:id" --> R
  MD -- "SUBSCRIBE media:id" --> R
  RC -. "gRPC: RecorderControl (no server)" .-> MD
```

- Clients open one gateway WebSocket for ops and events (contract §6).
- The gateway sends a bearer token to Takusen `GET /api/v1/users/@me` at IDENTIFY and RESUME. It does not validate tokens itself.
- The gateway reads Postgres directly for the READY payload and for `media_nodes.signaling_url`. It does not write to Postgres.
- Takusen publishes each REST mutation to Redis `guild:{id}` or `user:{id}`. The gateway receives these events through one `PSUBSCRIBE` per process (§5).
- The gateway keeps sessions, the resume buffer, presence and voice state in Redis. It also publishes `VOICE_STATE_UPDATE` to `guild:{id}` and `PRESENCE_UPDATE` to `guild:{id}` and `user:{id}`.
- On a voice join, the gateway calls Takusen gRPC `PlaceMediaSession`. Then it mints a PASETO voice token and TURN credentials (§7, §9).
- Clients connect to the media node on `/voice` with the voice token, and send RTP over UDP (§8).
- The media node calls `RegisterMediaNode` at start and `MediaNodeHeartbeat` every 10 s (§9).
- The gateway sends kicks to a media node on Redis `media:{nodeId}`.
- coturn relays media for clients behind strict NAT. The gateway only mints the credentials. Neither binary talks to coturn.
- The recorder dials a `RecorderControl` gRPC service. The media node does not serve it yet.

## Code architecture

```mermaid
flowchart TB
  subgraph gateway["cmd/hachiman-gateway"]
    GM["main.go<br/>flags, wiring"]
    GC["conn.go<br/>serveWS, handshake, readLoop"]
    GS["session.go<br/>session.run(), dispatch, VIEW_CHANNEL"]
    GB["bus.go<br/>runBus(), Lua scripts, keys"]
    GR["ready.go<br/>pgLoader(), pgNodeURL()"]
    GV["voice.go<br/>onVoice(), resolveNode(), kick()"]
    GM --> GC --> GS
    GB -- "busEvent" --> GS
    GS --> GR
    GS --> GV
  end

  subgraph mediabin["cmd/hachiman-media"]
    MM["main.go + args.go<br/>flags, wiring"]
    MV["voice.go<br/>voiceServer, voiceConn"]
    MT["takusen.go<br/>runTakusenRegistration()"]
    MK["kick.go<br/>runKickSubscriber()"]
    MM --> MV
    MM --> MT
    MM --> MK
    MK -- "kick()" --> MV
  end

  subgraph pkgs["pkg"]
    PS["media<br/>SFU, Client"]
    PP["media<br/>SSRCPool"]
    PT["voicetoken<br/>Signer, Verifier, ReplayCache"]
    PC["coturn<br/>CoturnRegion"]
    PK["takusenclient<br/>Client"]
    PM["management<br/>proto + generated"]
    PE["permissions"]
    PS --> PP
    PK --> PM
  end

  GV --> PT
  GV --> PC
  GV --> PK
  GS --> PE
  MV --> PS
  MV --> PT
  MT --> PK
```

| Path | What |
|---|---|
| `cmd/hachiman-gateway` | Stateless WebSocket gateway on `/gateway`. HELLO, IDENTIFY, RESUME, event dispatch with VIEW_CHANNEL filtering, presence, voice join and voice-token minting. Run N identical nodes behind a load balancer. |
| `cmd/hachiman-media` | Stateless WebRTC SFU on `/voice`. Verifies voice tokens, forwards mic audio and screen video, relays speaking state. Registers with Takusen gRPC and takes kicks from Redis. |
| `cmd/hachiman-recorder` | Recording scaffold. Dials `RecorderControl` gRPC, which media does not serve. `pnpm build:server` does not build it. |
| `pkg/media` | SFU (`sfu.go`) and `SSRCPool` (`ssrc_pool.go`). Only hachiman-media imports it. |
| `pkg/voicetoken` | PASETO v4.public voice token: `Signer` (gateway), `Verifier` and `ReplayCache` (media). |
| `pkg/coturn` | Per-region TURN credential minting (HMAC-SHA1, coturn REST API scheme) for `iceServers`. |
| `pkg/takusenclient` | Client for the management gRPC: `RegisterMediaNode`, `MediaNodeHeartbeat`, `PlaceMediaSession`. |
| `pkg/management` | Management gRPC proto (`hachiman.management.v1`) and generated code. |
| `pkg/permissions` | Permission bit math. `sync_test.go` compares it with `pkgs/hachiman-client/src/permissions.ts`. |
| `pkg/recorderproto` | Media to recorder proto (scaffold). |

### Gateway session lifecycle

```mermaid
sequenceDiagram
  participant C as Client
  participant G as Gateway node
  participant T as Takusen REST
  participant R as Redis
  participant P as Postgres

  C->>G: connect /gateway
  G->>C: op 10 HELLO (heartbeatInterval)
  C->>G: op 2 IDENTIFY (token)
  G->>T: GET /api/v1/users/@me
  G->>P: load guilds, channels, roles, DMs
  G->>R: HSET session:{id} userId, seq, owner
  G->>C: op 0 READY
  loop every heartbeatInterval
    C->>G: op 1 HEARTBEAT
    G->>R: EXPIRE session, events, presence, user_sessions
    G->>C: op 11 HEARTBEAT_ACK
  end
  R-->>G: guild:{id} or user:{id} event
  G->>R: appendScript (owner check, seq + 1, LPUSH events:{id})
  G->>C: op 0 dispatch (if VIEW_CHANNEL)
  Note over C,G: socket drops, session waits 60 s
  C->>G: op 6 RESUME (token, sessionId, seq) on any node
  G->>R: takeoverScript (set new owner, read seq + buffer)
  G->>C: replay frames after seq, then RESUMED
  Note over G,R: old owner's next append fails, so it stops
```

A missing session or a gap in the buffer gives op 9 INVALID_SESSION. The client then sends IDENTIFY on the same socket.

### Media session lifecycle

```mermaid
sequenceDiagram
  participant C as Client
  participant M as Media node
  participant S as pkg/media SFU
  participant R as Redis

  C->>M: identify (voice token), within 10 s
  M->>M: Verify (signature, exp, aud, jti replay)
  M->>M: close old conn with same sessionId (4011)
  M->>S: Join(sessionId, userId, channelId)
  S-->>M: existing peers get Renegotiate + PeersChanged
  M->>C: ready (sessionId, ssrc)
  M->>C: peers (snapshot)
  M->>C: offer
  C->>M: answer
  C->>M: candidate (both ways)
  Note over M,C: a peer joins or leaves the room
  M->>C: peers, then offer
  C->>M: answer
  R-->>M: media:{nodeId} kick (sessionId, channelId)
  M->>C: close 4010
```

Media is always the offerer. If a renegotiation starts while an answer is outstanding, media sends one follow-up offer after the answer arrives.

## Run locally

1. Start Postgres and Redis: `docker compose -f docker/docker-compose.yml up -d` (repo root).
2. Run the Takusen DB migrations and seed: `pnpm -F @hachiman/takusen db:migrate && pnpm -F @hachiman/takusen db:seed`.
3. Start Takusen: `pnpm dev:takusen` (Next.js REST and auth on `:3000`, management gRPC on `127.0.0.1:50051`).
4. Start the server processes: `pnpm dev:server` runs gateway and media together with nodemon hot reload. To start only one, use `pnpm dev:gateway` or `pnpm dev:media`.

Dev defaults: gateway on `ws://localhost:8080/gateway`, media on `ws://localhost:8090/voice`.
Gateway and media share the voice key file `.dev/keys/voice-signer.ed25519`. If the file does not exist, the gateway creates it.

## Environment

The dev scripts start nodemon with `node --env-file-if-exists=../../.env`, so `go run` gets the repo-root `.env`.
To make the file, copy the repo-root `.env.example`. A variable that is already set in your shell keeps its value.

In the Claude sandbox, set `GOCACHE=$TMPDIR/gocache CGO_ENABLED=0` before `go build` or `go test`.

## Flags

The contract is the source of truth (gateway §6, voice token §7, media §8). Run a binary with `--help` for the full list. A flag overrides its env var.

### hachiman-gateway

| Flag | Env | Default / notes |
|---|---|---|
| `--listen` | `GATEWAY_LISTEN_ADDR` | `:8080`. Serves `/gateway` and `/healthz` |
| `--database-url` | `DATABASE_URL` | `postgres://takusen:takusen@localhost:5432/takusen` (the Takusen DB) |
| `--redis-url` | `REDIS_URL` | `redis://localhost:6379`. Event bus, sessions, presence, voice state |
| `--takusen-url` | `TAKUSEN_URL` | `http://localhost:3000`. IDENTIFY calls `GET {TAKUSEN_URL}/api/v1/users/@me` |
| `--takusen-grpc-addr` | `TAKUSEN_GRPC_ADDR` | `127.0.0.1:50051`. `PlaceMediaSession` |
| `--voice-key` | `VOICE_KEY` | `.dev/keys/voice-signer.ed25519`. Ed25519 seed file for voice tokens. The gateway creates it if it is missing |
| `--turn-secret`, `--turn-urls` | `TURN_SECRET`, `TURN_URLS` | Optional. If one is empty, clients get the Google STUN server only |
| `--turn-ttl` | | `5m`. TURN credential lifetime |

### hachiman-media

| Flag | Env | Default / notes |
|---|---|---|
| `--node-id` | `MEDIA_NODE_ID` | `media-<hostname>`. Token `aud` and Takusen registry key |
| `--region` | `MEDIA_REGION` | `dev` |
| `--listen` | | `:8090`. Serves `/voice` and `/healthz` |
| `--signaling-url` | | `ws://localhost:8090/voice`. Public voice WS URL that media registers with Takusen |
| `--takusen-grpc-addr` | `TAKUSEN_GRPC_ADDR` | `127.0.0.1:50051`. Empty disables registration, so placement cannot select the node |
| `--redis-url` | `REDIS_URL` | `redis://localhost:6379`. `media:{nodeId}` kick channel |
| `--voice-pubkey` | `VOICE_PUBKEY` | Hex Ed25519 public key of the gateway signer (production) |
| `--voice-key` | `VOICE_KEY` | Seed file shared with the gateway (dev). Media ignores it when `--voice-pubkey` is set |
| `--public-ip` | | Public IP for ICE host candidates (pion NAT 1:1) |
| `--udp-port-min`, `--udp-port-max` | | RTP and DTLS-SRTP UDP range. `0` gives ephemeral ports. Publish the range in containers |
| `--max-sessions` | | `500`. Capacity that media reports to Takusen placement |
| `--log` | | Log file path. Empty writes to stderr |

## Tests

```bash
cd apps/hachiman-server && CGO_ENABLED=0 go test ./...
```

This runs the gateway, media, SFU, voice token, coturn, takusenclient and permission tests. `pkg/permissions/sync_test.go` reads the TS permission file and fails on a name or value mismatch.

The gateway integration test has the build tag `integration`. It needs a running Postgres, Redis and Takusen, and these variables: `DATABASE_URL`, `REDIS_URL`, `TAKUSEN_URL` and `HACHIMAN_TEST_TOKEN` (a Takusen access token).

```bash
go test -tags integration -run Integration ./cmd/hachiman-gateway/
```

## Build

`pnpm build:server` builds `hachiman-gateway` and `hachiman-media` into `./bin`. To build one binary, use `pnpm -F hachiman-server build:gateway` or `build:media`.

Docker images: `Dockerfile.gateway`, `Dockerfile.media`, `Dockerfile.recorder` and the `Dockerfile.arm32v6.*` variants. Each image builds one binary.
The gateway image exposes `8080/tcp`. The media image exposes `8090/tcp`. For media, also publish the UDP range or use host networking.

## Regenerate protos

Do not edit `*.pb.go` by hand. Change the `.proto` file, then run `go generate` (it needs `protoc`, `protoc-gen-go` and `protoc-gen-go-grpc`):

```bash
go generate ./pkg/management/      # management.proto, contract §9
go generate ./pkg/recorderproto/   # RecorderControl.proto
```

Takusen loads `management.proto` at runtime, so a proto change has no TS generation step. Update contract §9 in the same change.

## Review

For changes to `pkg/media`, `cmd/hachiman-media/voice.go` or `pkgs/hachiman-client/src/voice.ts`, use the `webrtc-reviewer` agent. It finds SSRC pool and renegotiation race bugs that a generic review does not find.

## License

This module derives from BSD-licensed upstream code. See `LICENSE` and `AUTHORS` for the copyright notice.
