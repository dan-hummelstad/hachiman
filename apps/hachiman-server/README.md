# hachiman-server

Go module `hachiman/server`. It holds the realtime processes of Hachiman: the WebSocket gateway, the WebRTC media node and a recorder scaffold.
Takusen (`apps/takusen`) owns auth, the REST API, the E2EE delivery service and the Postgres schema. The wire contract is [`docs/gateway-protocol.md`](../../docs/gateway-protocol.md).

Both binaries relay only ciphertext and hold no keys. The gateway accepts only E2EE clients and delivers device-scoped events (§12.13). The media node relays and orders the voice MLS group and forwards SFrame payloads unchanged (§8, §12.10).

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
  C -- "WS: SDP/ICE, peers, speaking, e2ee_*" --> MD
  C -- "UDP: RTP / DTLS-SRTP, SFrame payloads" --> MD
  C -. "TURN relay" .-> TURN
  GW -- "HTTP: GET /users/@me" --> TR
  GW -- "gRPC: PlaceMediaSession" --> TG
  MD -- "gRPC: Register + Heartbeat" --> TG
  GW -- "SQL: READY, devices, media_nodes" --> PG
  TR -- "PUBLISH guild:* user:* device:*" --> R
  TG -- "PUBLISH device:* (MLS batches)" --> R
  GW -- "PSUBSCRIBE, keys, PUBLISH media:id" --> R
  MD -- "SUBSCRIBE media:id" --> R
  RC -. "gRPC: RecorderControl (no server)" .-> MD
```

- Clients open one gateway WebSocket for ops and events (contract §6).
- The gateway sends a bearer token to Takusen `GET /api/v1/users/@me` at IDENTIFY and RESUME. It does not validate tokens itself.
- The gateway reads Postgres directly for the READY payload, for the `devices` row at IDENTIFY and RESUME, and for `media_nodes.signaling_url`. It does not write to Postgres.
- Takusen publishes each REST mutation to Redis `guild:{id}`, `user:{id}` or `device:{id}`. The gateway receives these events through one `PSUBSCRIBE` per process (§5, §12.13).
- The gateway keeps sessions, the resume buffer, presence and voice state in Redis. It also publishes `VOICE_STATE_UPDATE` to `guild:{id}` and `PRESENCE_UPDATE` to `guild:{id}` and `user:{id}`.
- On a voice join, the gateway calls Takusen gRPC `PlaceMediaSession`. Then it mints a PASETO voice token and TURN credentials (§7, §9).
- Clients connect to the media node on `/voice` with the voice token and a key package, and send RTP over UDP (§8). Each RTP payload is an SFrame frame.
- The media node calls `RegisterMediaNode` at start and `MediaNodeHeartbeat` every 10 s (§9).
- The gateway sends kicks to a media node on Redis `media:{nodeId}`.
- coturn relays media for clients behind strict NAT. The gateway only mints the credentials. Neither binary talks to coturn.
- The recorder dials a `RecorderControl` gRPC service. The media node does not serve it yet.

## Code architecture

```mermaid
flowchart TB
  subgraph gateway["cmd/hachiman-gateway"]
    GM["main.go<br/>flags, wiring"]
    GC["conn.go<br/>serveWS, handshake, readLoop,<br/>checkClient(), checkDevice()"]
    GSV["semver.go<br/>parseSemver()"]
    GS["session.go<br/>session.run(), dispatch, VIEW_CHANNEL"]
    GB["bus.go<br/>runBus(), Lua scripts, keys"]
    GR["ready.go<br/>pgLoader(), pgNodeURL(), pgDevice()"]
    GV["voice.go<br/>onVoice(), resolveNode(), kick()"]
    GCS["custom_status.go<br/>sanitizeCustomStatus()"]
    GM --> GC --> GS
    GS --> GCS
    GC --> GSV
    GC --> GR
    GB -- "busEvent (guild, user, device)" --> GS
    GS --> GR
    GS --> GV
  end

  subgraph mediabin["cmd/hachiman-media"]
    MM["main.go + args.go<br/>flags, wiring"]
    MV["voice.go<br/>voiceServer, voiceConn"]
    MT["takusen.go<br/>runTakusenRegistration()"]
    MK["kick.go<br/>runKickSubscriber()"]
    ME["e2ee.go<br/>e2eeState: roster, relay,<br/>commit order, failover"]
    MW["e2ee_wire.go<br/>base64url, commit header parse"]
    MM --> MV
    MV -- "e2ee_* ops, join, leave" --> ME
    ME --> MW
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
| `cmd/hachiman-gateway` | Stateless WebSocket gateway on `/gateway`. HELLO, IDENTIFY and RESUME with the §12.13 checks, event dispatch (VIEW_CHANNEL filter, device scope), presence, voice join, voice tokens. Run N identical nodes behind a load balancer. |
| `cmd/hachiman-media` | Stateless WebRTC SFU on `/voice`. Verifies voice tokens, forwards mic audio and screen video (SFrame payloads, unchanged), relays speaking state. Registers with Takusen gRPC and takes kicks from Redis. |
| `cmd/hachiman-media/e2ee.go` | Voice E2EE (§8, §12.10.1): the room roster, the committer choice, the relay of key packages, Welcomes and ratchet trees, and the commit order. It has no MLS library and signs nothing. |
| `cmd/hachiman-media/e2ee_wire.go` | Strict base64url (§12.2), the voice group id, and the parse of the fixed MLS commit header (version, wire format, group id, epoch, sender leaf). |
| `cmd/hachiman-recorder` | Recording scaffold. Dials `RecorderControl` gRPC, which media does not serve. `pnpm build:server` does not build it. |
| `pkg/media` | SFU (`sfu.go`) and `SSRCPool` (`ssrc_pool.go`). Only hachiman-media imports it. |
| `pkg/voicetoken` | PASETO v4.public voice token: `Signer` (gateway), `Verifier` and `ReplayCache` (media). `Claims` carries `DeviceID`. The media node refuses a token without it (4004). |
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
  C->>G: op 2 IDENTIFY (token, deviceId, capabilities, clientVersion)
  G->>T: GET /api/v1/users/@me
  G->>G: checkClient: e2ee/1 and clientVersion >= minimum (else 4012)
  G->>P: checkDevice: devices row of this user, not revoked (else 4013)
  G->>P: load guilds, channels, roles, DMs, read states
  G->>R: HSET session:{id} userId, deviceId, seq, owner
  G->>R: SET device_online:{deviceId} = sessionId
  G->>P: checkDevice again (revocation race)
  G->>C: op 0 READY (with deviceId)
  loop every heartbeatInterval
    C->>G: op 1 HEARTBEAT
    G->>R: EXPIRE session, events, presence, user_sessions, device_online
    G->>C: op 11 HEARTBEAT_ACK
  end
  R-->>G: guild:{id}, user:{id} or device:{id} event
  G->>R: appendScript (owner check, seq + 1, LPUSH events:{id})
  G->>C: op 0 dispatch (if VIEW_CHANNEL)
  R-->>G: device:{id} DEVICE_REVOKED (internal, not forwarded)
  G->>C: close 4013, end the session (no RESUME)
  Note over C,G: socket drops, session waits 60 s
  C->>G: op 6 RESUME (token, sessionId, seq, deviceId) on any node
  G->>P: checkDevice (else 4013)
  G->>R: takeoverScript (same deviceId, set new owner, read seq + buffer)
  G->>C: replay frames after seq
  G->>P: checkDevice again (revocation race)
  G->>C: RESUMED
  Note over G,R: old owner's next append fails, so it stops
```

RESUME runs the token check and the device check, not the capability check. A RESUME without `deviceId` gives 4013. A missing session, a gap in the buffer or another valid `deviceId` than the stored one gives op 9 INVALID_SESSION. The client then sends IDENTIFY on the same socket.

Device scope (§12.13): each session is in the index of its user, its device and its guilds. An event on `device:{id}` goes to every session of that device. The Takusen batch scheduler reads `device_online:{deviceId}` to choose an online committer. The gateway deletes the key when the session ends.

Gateway close codes for E2EE. The client does not reconnect after them:

| Code | When |
|---|---|
| 4012 | IDENTIFY has no `e2ee/1` capability, or `clientVersion` is not a semver at or above `--min-client-version`. |
| 4013 | The device row does not exist, belongs to another user or is revoked. Also sent on `DEVICE_REVOKED`. The shared UI then signs out. |

If the device lookup itself fails, the gateway closes with 4000, and the client tries again.

### READY, presence and voice state

- **Read states.** READY carries `readStates` for every DM and for each guild text or pages channel that the session can view (`visibleReadStates`). One query (`readStatesSQL`) gives the last read message, the last message and `unreadCount`: the messages of other authors after the read position, capped at 100. A channel without a read state has `unreadCount` 0, and the client uses `lastMessageId` to show it as unread.
- **Threads.** READY carries at most 50 threads per guild (`readyThreadCap`), the most recently active ones. A thread gets the permissions of its parent channel. A thread with an unknown parent gets no permissions.
- **Roles.** Each role carries `hoist` (`roles.hoist`).
- **Custom status.** Op 3 takes `customStatus` beside `status`. An absent field keeps its value, and `customStatus: null` clears it. `sanitizeCustomStatus` removes control characters, trims the text, and refuses a text over 64 characters or an `expiresAt` that is not RFC 3339. The gateway writes Redis `custom_status:{userId}`: no TTL without `expiresAt`, else it expires at `expiresAt`. `PRESENCE_UPDATE` and the READY presences carry it, but only with a presence that is not `offline`.
- **Events from Takusen.** `READ_STATE_UPDATE` and `USER_BLOCK_UPDATE` come on `user:{id}`. `CHANNEL_PINS_UPDATE` comes with a `channelId`, so the VIEW_CHANNEL filter applies. `GUILD_EVENT_*` and `GUILD_EMOJIS_UPDATE` come on `guild:{id}`. The gateway does not cache them.
- **Call start.** Each voice state carries `joinedAt` (RFC 3339). The gateway sets it on a join and on a channel move, and keeps it across mute, deafen and stream changes. The call start of a channel is the oldest `joinedAt` of its states.

### Pages relay

Pages (contract §6) add one client op and two ephemeral events:

- Op 5 `DOC_AWARENESS {channelId, pageId, envelope}`: the gateway drops the frame unless the session is READY, the channel is a guild `pages` channel that the session can view, the envelope is at most 8 KiB, and the session is under 20 frames per second. It then publishes `DOC_AWARENESS` to `guild:{id}`.
- `DOC_UPDATE` (published by Takusen) and `DOC_AWARENESS` go out without `s` and do not enter `events:{sessionId}`, so a burst of edits cannot push message events out of the resume buffer. Clients fill gaps from the per-page `seq`.
- Every connection has a read limit of 64 KiB (close 1009).

Code: `cmd/hachiman-gateway/conn.go` (op 5, read limit), `session.go` (the checks, the ephemeral dispatch), tests in `pages_test.go`.

### Media session lifecycle

```mermaid
sequenceDiagram
  participant C as Client
  participant M as Media node
  participant S as pkg/media SFU
  participant R as Redis

  C->>M: identify (voice token, e2ee {version 1, keyPackage}), within 10 s
  M->>M: e2ee check (else 4012), key package is base64url (else 4014)
  M->>M: Verify (signature, exp, aud, jti replay), deviceId claim (else 4004)
  M->>M: close old conn with same sessionId (4011)
  M->>S: Join(sessionId, userId, channelId)
  S-->>M: existing peers get Renegotiate + PeersChanged
  M->>C: ready (sessionId, ssrc)
  M->>C: peers (snapshot)
  M->>C: e2ee_roster (every session)
  M->>C: offer
  C->>M: answer
  C->>M: candidate (both ways)
  Note over M,C: a peer joins or leaves the room
  M->>C: peers, then offer
  C->>M: answer
  R-->>M: media:{nodeId} kick (sessionId, channelId)
  M->>C: close 4010
```

Media is always the offerer. If a renegotiation starts while an answer is outstanding, media sends one follow-up offer after the answer arrives. On a leave, the media node sends the E2EE roster before the SFU removes the peer. Thus peers get the roster before the offer.

### Voice E2EE relay and ordering

```mermaid
sequenceDiagram
  participant J as Joiner
  participant M as Media node (e2ee.go)
  participant K as Committer
  participant O as Other members

  Note over M: First session in an empty room: new group id, epoch null
  M->>K: e2ee_roster (create: true)
  K->>M: e2ee_ready (transitionId null)
  M->>M: room epoch = 0
  J->>M: identify with keyPackage
  M->>K: e2ee_roster (pending: joiner), e2ee_key_package
  K->>M: e2ee_commit (epoch, commit, welcome, added)
  K->>M: e2ee_ratchet_tree (epoch + 1)
  M->>M: parse the commit header, first commit for the room epoch wins
  M->>K: e2ee_prepare_transition
  M->>O: e2ee_prepare_transition
  M->>J: e2ee_welcome, e2ee_ratchet_tree
  K->>M: e2ee_ready
  O->>M: e2ee_ready
  J->>M: e2ee_ready (leafIndex)
  M->>K: e2ee_execute_transition (all ready, or after 3 s)
  M->>O: e2ee_execute_transition
  M->>J: e2ee_execute_transition
```

- The media node has no MLS library. It signs nothing, proposes nothing and commits nothing. One mutex guards all rooms. The media node closes sockets only after it releases the mutex.
- **Committer.** Before the group exists, the earliest joiner creates it. After that, the member with the lowest reported leaf index commits. If no commit arrives 5 s after new work, the next member gets the role, and the media node sends the roster again.
- **Order.** The media node checks version, wire format, group id, epoch, sender type and sender leaf in the commit header. The sender leaf must be the leaf that the sending member reported. Any member can commit, not only the selected committer. The media node accepts the first commit whose epoch is the room epoch. Other commits get `e2ee_commit_rejected`, and so do commits while a transition is not executed yet, and commits whose `added` or `removed` lists are out of date.
- **No ratchet tree.** When the committer sent a Welcome and its `e2ee_ratchet_tree` does not arrive within 10 s, the media node closes it with 4014. The room stays in the previous epoch.
- **Bad commits.** The media node closes the committer with 4014 when enough members send `e2ee_invalid` for one transition. Enough is at least two members, or all other members if fewer than two exist. The members stay in the previous epoch. A single `e2ee_invalid` closes only that member with 4013.
- The media node closes a member with 4013 when it sends no `e2ee_ready` within 10 s. When no member holds the group state any more, the room starts a new group.

Media close codes for E2EE:

| Code | When |
|---|---|
| 4012 | `identify` has no `e2ee` field, or the version is not 1. |
| 4013 | Resync: the client sent `e2ee_invalid`, or no `e2ee_ready` came within 10 s. The client joins again with a new leaf. |
| 4014 | Protocol violation: a malformed op or key package, a commit for another group or with a false leaf, a commit that members reject, or no `e2ee_ratchet_tree` 10 s after a commit with a Welcome. |

`MEDIA_WS_READ_LIMIT` (default 1 MiB) sets the largest client frame. Commits, Welcomes and ratchet trees of a large call use the same socket.

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
| `--min-client-version` | `GATEWAY_MIN_CLIENT_VERSION` | `0.1.0`. Lowest IDENTIFY `clientVersion`. Older clients get close 4012. The gateway does not start if the value is not a semver |
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
| | `MEDIA_WS_READ_LIMIT` | `1048576` (1 MiB). Largest voice WebSocket frame in bytes. Env only, no flag. Media does not start if the value is not a positive integer |

## Tests

```bash
cd apps/hachiman-server && CGO_ENABLED=0 go test ./...
```

This runs the gateway, media, SFU, voice token, coturn, takusenclient and permission tests. The gateway tests include the device checks. The media tests include the E2EE relay and the commit header parse. `pkg/permissions/sync_test.go` reads the TS permission file and fails on a name or value mismatch.

The gateway integration test has the build tag `integration`. It needs a running Postgres, Redis and Takusen, and these variables: `DATABASE_URL`, `REDIS_URL`, `TAKUSEN_URL` and `HACHIMAN_TEST_TOKEN` (a Takusen access token). The test registers a pending device with a fresh MLS key (`POST /api/v1/devices` with its device proof) and signs IDENTIFY and RESUME with that key.

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

For changes to `pkg/media`, `cmd/hachiman-media/voice.go`, `cmd/hachiman-media/e2ee.go` or `pkgs/hachiman-client/src/voice.ts`, use the `webrtc-reviewer` agent. It finds SSRC pool and renegotiation race bugs that a generic review does not find. For `e2ee.go`, also tell it to examine the order of roster and renegotiation and the committer failover.

## License

This module derives from BSD-licensed upstream code. See `LICENSE` and `AUTHORS` for the copyright notice.
