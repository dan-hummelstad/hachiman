# hachiman-server

Go module `hachiman/server`. It holds the realtime and media processes of Hachiman.
Oracle (`apps/oracle`) owns auth, the REST API and the Postgres schema. The wire
contracts live in [`docs/gateway-protocol.md`](../../docs/gateway-protocol.md).

## Layout

| Path | What |
|---|---|
| `cmd/hachiman-gateway` | Stateless WebSocket gateway (`/gateway`). HELLO/IDENTIFY/RESUME, event dispatch from Redis, presence, voice join + voice-token minting. Run N identical nodes behind a load balancer. |
| `cmd/hachiman-media` | Stateless WebRTC SFU. Voice WebSocket (`/voice`) for SDP/ICE, peers and speaking state. Registers and heartbeats with Oracle gRPC. Takes kicks from Redis `media:{nodeId}`. |
| `cmd/hachiman-recorder` | Recording scaffold. Not wired to media yet. |
| `pkg/media` | SFU primitives (SSRC pool, peer connections). |
| `pkg/voicetoken` | PASETO voice token: `Signer` (gateway), `Verifier` (media). |
| `pkg/management` | Oracle management gRPC proto + generated code. |
| `pkg/oracleclient` | Client for the management gRPC (register, heartbeat, placement). |
| `pkg/permissions` | Permission bit math, shared with the TS client. |
| `pkg/coturn` | TURN REST credential minting for `iceServers`. |
| `pkg/recorderproto` | Media ↔ recorder proto (scaffold). |

## Run locally

1. Start Postgres and Redis: `docker compose -f docker/docker-compose.yml up -d` (repo root).
2. Run the Oracle DB migrations.
3. Start Oracle: `pnpm dev:oracle` (Next.js REST + auth on `:3000`, management gRPC on `127.0.0.1:50051`).
4. Start the server processes: `pnpm dev:server` runs gateway and media together with nodemon
   hot reload. To start only one, use `pnpm dev:gateway` or `pnpm dev:media`.

Environment: the dev scripts start nodemon with `node --env-file-if-exists=../../.env`, so `go run` gets the
repo-root `.env`. To make it, copy the repo-root `.env.example`. A variable that is already set in your shell keeps its value.

Dev defaults: gateway on `ws://localhost:8080/gateway`, media on `ws://localhost:8090/voice`.
Gateway and media share the voice key file `.dev/keys/voice-signer.ed25519`
(if the file does not exist, the gateway creates it).

Build binaries into `./bin`: `pnpm build:server` (or `pnpm -F hachiman-server build:gateway` / `build:media`).
Docker images: `Dockerfile.{gateway,media,recorder}` and the `Dockerfile.arm32v6.*` variants.

In the Claude sandbox, set `GOCACHE=$TMPDIR/gocache CGO_ENABLED=0` before `go build`.

## Flags / env

The contract is authoritative (gateway: §6, voice token: §7, media: §8). Run a binary with `--help` for the full list.

| Process | Flag | Env | Default / notes |
|---|---|---|---|
| gateway | `--listen` | `GATEWAY_LISTEN_ADDR` | `:8080` |
| gateway | `--database-url` | `DATABASE_URL` | Postgres (the Oracle DB) |
| gateway | `--redis-url` | `REDIS_URL` | event bus, sessions, presence, voice state |
| gateway | `--oracle-url` | `ORACLE_URL` | IDENTIFY calls `GET {ORACLE_URL}/api/v1/users/@me` |
| gateway | `--oracle-grpc-addr` | `ORACLE_GRPC_ADDR` | `PlaceMediaSession` |
| gateway | `--voice-key` | `VOICE_KEY` | Ed25519 seed for minting voice tokens |
| gateway | `--turn-secret`, `--turn-urls` | `TURN_SECRET`, `TURN_URLS` | optional. If not set, the Google STUN fallback |
| media | `--node-id`, `--region` | `MEDIA_NODE_ID`, `MEDIA_REGION` | identity registered with Oracle |
| media | `--listen` | | `:8090` |
| media | `--signaling-url` | | public voice WS URL, e.g. `ws://localhost:8090/voice` |
| media | `--oracle-grpc-addr` | `ORACLE_GRPC_ADDR` | register + heartbeat every 10 s |
| media | `--redis-url` | `REDIS_URL` | `media:{nodeId}` kick channel |
| media | `--voice-pubkey` or `--voice-key` | `VOICE_PUBKEY`, `VOICE_KEY` | verifies voice tokens |
| media | `--public-ip` | | pion NAT 1:1 when behind NAT |
| media | `--udp-port-min`, `--udp-port-max` | | RTP/DTLS-SRTP UDP range. Publish it in containers |

A flag overrides its env var.

## License

This module derives from BSD-licensed upstream code. See `LICENSE` and `AUTHORS` for the copyright notice.
