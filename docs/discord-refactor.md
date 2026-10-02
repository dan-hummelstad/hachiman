# Discord-Architecture Refactor — Audit & Plan (rev 2)

Branch: `refactor`. Goal: remove the Mumble architecture entirely. Guilds are database rows,
not processes. Server processes are stateless. Clients speak REST + a WebSocket gateway,
not Mumble.proto. The refactor removes all Mumble/Murmur/Grumble naming. Managed-only (no self-host,
no SQLite, no SuperUser).

**Wire contracts live in [`docs/gateway-protocol.md`](gateway-protocol.md)**: entity shapes, permission bits, schema,
REST routes, Redis keys, gateway ops, voice token, media voice WS, management proto, client-lib API, platform seam.
This file holds the decisions and the execution plan.

Decisions (settled):
- **Protocol**: Full Discord split. REST API for CRUD, a WSS gateway for realtime events, WebRTC for voice. Delete Mumble.proto.
- **State**: Postgres holds durable data (guilds, channels, members, messages, roles). Redis holds ephemeral state (sessions, presence, voice state, pub/sub event bus).
- **Self-host**: dropped. Delete SQLite, `murmur.sqlite`, SuperUser and port 64738.
- **Scope**: guilds, channels, messages and voice, plus Discord-style roles and permission overwrites, presence and DMs.

## 0. Review fixups (rev 1 → rev 2)

A code audit of rev 1 found these corrections. The sections below already include them.

| # | Rev 1 said | Reality → decision |
|---|---|---|
| 1 | Gateway IDENTIFY "reuses control's introspection code" | Control introspects **per-vServer** tokens and rejects any other `client_id`. The gateway would get `hachiman-client` user tokens. **Decision:** the gateway calls `GET {ORACLE_URL}/api/v1/users/@me` with the bearer token. `requireUser()` already resolves bearer tokens in-process via panva. This needs no confidential client, no introspection policy and no JWT switch. Delete the per-server tokens (`/api/me/server-tokens`, `server-tokens.ts`, per-server `oidc_clients`). |
| 2 | Media has "PASETO voice-token auth"; key renames from `murmur.key` | Media verifies nothing today, and `murmur.key` never existed. Nothing uses `pkg/voicetoken`. `FileSigner` can only mint for its own node. **Decision:** split it into `Signer` (gateway, mints for any `aud`) and `Verifier` (media). Drop the DTLS-fingerprint binding. Key: `.dev/keys/voice-signer.ed25519`. |
| 3 | "Adapt sidechannel; it dials the gateway fleet; keep room membership / SubscriptionMatrixUpdate" | Media dials one loopback-only control. Membership and SubscriptionMatrix exist only in the proto. A multi-node gateway would need discovery, mTLS and cross-node routing. **Decision: delete the sidechannel (`pkg/mediaproto`).** Media registers and heartbeats straight to Oracle gRPC (`pkg/oracleclient`). The client→media voice WS carries SDP/ICE, peers and speaking state. Gateway→media is only "kick", sent over Redis `media:{nodeId}`. |
| 4 | Session id `vServerID:mumbleSession` → `guild:channel:user` is a rename | The SFU and SSRC pool use a uint32 key. That uint32 *is* the Mumble session and the SSRC. Room = bare channel id. As a result, there is a cross-vServer collision bug. `AddClient` wires every client on the node, not just the room. **Decision:** re-key the SFU by string session id and room = channel UUID. Allocate SSRCs per node. Output tracks go to room peers only. |
| 5 | Client "connects directly to media's WS endpoint" | Media has no client listener and an empty pion config. Oracle placement returns an empty `addr` and SSRC 0. **Decision:** new voice WS listener, `--signaling-url` registered with Oracle (`media_nodes.signaling_url`), and pion NAT 1:1 + UDP port range flags. |
| 6 | `PlaceMediaSession` unchanged | `channel_id` is uint64 and `tenant_id` is the vServer. **Decision:** string `channel_id` + `guild_id`, and the response is `{node_id, signaling_url}`. Channel→node stickiness lives in Redis `voice_room:{channelId}` (every user in a channel must land on one node). The proto package becomes `hachiman.management.v1`, service `Management`. Delete Create/DeleteVirtualServer and the control `service.go`/`listener.go`/`lifecycle.go`. |
| 7 | `pkg/coturn` keep | It imports `pkg/mumbleproto`, and no code calls it. **Decision:** return its own `ICEServer` struct. The gateway uses it for `VOICE_SERVER_UPDATE.iceServers` (STUN fallback). |
| 8 | Recorder "keep as-is" | It is a scaffold with no server peer (media implements no `RecorderControl`). **Decision:** leave it untouched and out of scope. It still builds. |
| 9 | Phase 7 deletes acl/database/sessionpool/mumbleproto | It also must delete `ban`, `blobstore`, `htmlfilter`, `islandmetrics`, `logtarget`, `serverconf`, `packetdata`, `replacefile`, `mediaproto`, the Go module path `mumble.info/grumble` (**done** → `hachiman/server`), `.goreleaser.yml`, the arm32v6 Dockerfiles, `docker/` compose comments + `init.sql` grumble schema, `.github/workflows/go.yml`, and the server docs (`ISLAND-METRICS.md`, `MANAGEMENT-API.md`, `THIN-RELAY-DESIGN.md`). |
| 10 | Oracle keep list | It also must delete `grumble-management.ts`, `managed-host.ts`, `user-servers.ts`, `server-tokens.ts`, `dns-verify.ts`, `oidc-client-admin.ts`, `islands.ts`, `scheduler*.ts`, `island-metrics.ts`, `virtual-servers.ts`, most of `servers.ts`/`server-schemas.ts`, domain verification, the `oidc-adapter` join on virtual_servers, the dashboard `servers/*` + `admin/islands/*` + `/discover` + `/join` + `/i/[code]` pages, the `TAKUSEN_MANAGED_GATEWAY_*` and `TAKUSEN_INVITE_SIGNING_KEY` env vars, and the `ISLAND-PLATFORM.md`/`REGION-CONTRACT.md` docs. `regions.probe_port` default goes 64738 → 443. |
| 11 | Invites "retarget to guilds" | Redemption today is anonymous and consumes on GET and on page render. It creates no membership, and it ships an HMAC key in the client bundle. **Decision:** `GET /api/v1/invites/:code` is a public, non-consuming preview. `POST` requires auth, creates membership and is idempotent. Delete the signed join payloads and `/join`. Deep link: `takusen://invite/<code>`. |
| 12 | "Oracle handler tests via in-memory repos (MediaNodesRepo pattern)" | Every Oracle lib imports `db` directly. A repo seam over ~30 routes would copy every query. **Decision:** no new seam. Test the permission lib as pure functions (TS + Go sync test). Test the routes end-to-end in the gateway integration test against real Postgres + Redis (`docker/docker-compose.yml` already has both). `MediaNodesRepo` stays as is. |
| 13 | Guild management UI unspecified | The `servers/*` UI of the Oracle dashboard uses vServer concepts. **Decision:** all guild management (settings, roles, overwrites, invites, members) lives in the Hachiman app. The Oracle dashboard keeps account/auth pages, an admin media-nodes view and the public `/invite/[code]` landing page. |
| 14 | "Keep slim IPlatformService (deep links, region probing)" | Deep links bypass that interface through ad-hoc globals (`window.takusen`, `window.hachimanOpenExternal`, raw `ipcRenderer`). The UI does not wire region probing. **Decision:** formalize `openExternal`, `onInviteCode`, `onOAuthCallback` and `probeRegions` into `IPlatformService` (contract §11). Once `pem`/TLS are gone, harden Electron (`contextIsolation: true`, `nodeIntegration: false`, everything through preload). The region probe moves out of the client lib into Electron main. |
| 15 | Voice events: VOICE_STATE_UPDATE / VOICE_SERVER_UPDATE | These miss speaking state, SSRC→user mapping, ICE servers and deafen semantics. **Decision:** speaking and `peers {userId, ssrc}` travel on the media voice WS. `iceServers` go in VOICE_SERVER_UPDATE. Deafen mutes local playback. One voice session per user globally. The client creates the PeerConnection per voice join (not at connect). Connection RTT = gateway heartbeat RTT. Delete the relay-metrics Health tab. |
| 16 | Message ids | UUIDs break the UI's numeric-id dedup and `bigint` cursors. **Decision:** Discord-style `nonce` on send (echoed in MESSAGE_CREATE). The cursor is `?before=<messageId>`, resolved server-side to `(created_at, id)`. |
| 17 | New package `@hachiman/client` | **Done:** `pkgs/hachiman-node` → `pkgs/hachiman-client`, name `@hachiman/client`, consumers on `workspace:*`. Consumed as TS source (no `dist`, no `tsc-alias`). Browser-safe only. |
| 18 | Uncommitted `ServersService` / `oracle-signin-dialog` changes | The UI rewrite replaces them (they also double-sync and leak connections). Keep the `oidc-provider.ts` cookie fix. |

## 1. Target architecture

```
                       ┌────────────────────────────────────┐
  HTTPS  ─────────────▶│  Oracle (Next.js + Drizzle)        │──▶ Postgres (durable)
  REST /api/v1         │  • identity / OIDC (unchanged)     │
                       │  • REST: guilds, channels, msgs,   │──▶ Redis PUBLISH guild:{id} / user:{id}
                       │    members, roles, invites, DMs    │
                       │  • gRPC: media registry + placement│◀── media register/heartbeat, gateway placement
                       └────────────────────────────────────┘
                       ┌────────────────────────────────────┐
  WSS /gateway ───────▶│  hachiman-gateway (Go, stateless,  │──▶ Redis: sessions, presence, voice state,
  (HELLO/IDENTIFY/     │  N identical nodes behind LB)      │    resume buffers, PSUBSCRIBE, PUBLISH media:{node}
   READY/DISPATCH/     │  • IDENTIFY → Oracle /users/@me    │──▶ Postgres (read-only, pgx)
   RESUME/VOICE_STATE) │  • mints PASETO voice tokens       │
                       └────────────────────────────────────┘
                       ┌────────────────────────────────────┐
  WSS /voice ─────────▶│  hachiman-media (Go, stateless SFU)│◀── Redis SUBSCRIBE media:{nodeId} (kick)
  WebRTC (SRTP) ──────▶│  • verifies PASETO voice token     │──▶ Oracle gRPC register/heartbeat
                       │  • SDP/ICE/peers/speaking on WS    │
                       └────────────────────────────────────┘
```

Key properties:
- **Guild create = one Postgres transaction.** No process boots. Any gateway node serves any guild.
- **Gateway is stateless.** Sessions and resume buffers live in Redis. A node crash only drops sockets, and clients RESUME on any node.
- **Voice mirrors Discord.** VOICE_STATE_UPDATE on the gateway → Redis voice state → sticky media node (Redis, else Oracle `PlaceMediaSession`) → `VOICE_SERVER_UPDATE {endpoint, token, iceServers}` → the client talks straight to the voice WS of the media node → WebRTC. There is no gateway↔media sidechannel.
- **Event flow**: REST mutation → Postgres commit → `PUBLISH guild:{id}|user:{id}` → every gateway node with a subscribed session dispatches the event (VIEW_CHANNEL-filtered). Clients send messages over REST.

## 2. Codebase verdicts (post-audit)

### apps/hachiman-server (Go module `hachiman/server`)

| Area | Verdict |
|---|---|
| `cmd/hachiman-control` (~9.3k LOC) | **Delete.** Replaced by `cmd/hachiman-gateway`. |
| `pkg/mumbleproto`, `pkg/mediaproto` | **Delete.** |
| `pkg/database`, `pkg/acl`, `pkg/sessionpool`, `pkg/ban`, `pkg/blobstore`, `pkg/htmlfilter`, `pkg/islandmetrics`, `pkg/logtarget`, `pkg/serverconf`, `pkg/packetdata`, `pkg/replacefile` | **Delete.** |
| `pkg/management` | **Adapt.** Keep the proto (renamed, fields per contract §9) and the generated code. Delete `service.go`, `listener.go`, `lifecycle.go` and their tests. |
| `pkg/oracleclient` | **Keep**, and update to the new proto. Used by media and the gateway. |
| `pkg/media` + `cmd/hachiman-media` | **Adapt.** String-keyed SFU, room-scoped tracks, voice WS listener, token verify, Oracle registration, Redis kick. |
| `pkg/voicetoken` | **Adapt** to Signer/Verifier (contract §7). |
| `pkg/coturn` | **Adapt.** Decouple from mumbleproto. |
| `pkg/permissions` | **New.** Go half of the permission lib + TS sync test. |
| `cmd/hachiman-gateway` | **New.** |
| `cmd/hachiman-recorder`, `pkg/recorderproto` | Untouched (scaffold, out of scope). |
| Dockerfiles / goreleaser / CI | control → gateway. Keep media and recorder. |

### pkgs/hachiman-client (`@hachiman/client`)

Rewrite to contract §10: `RestClient`, `GatewayClient`, `VoiceConnection`, `HachimanClient` (caches), `permissions`, `types`.
Delete: `client.ts`, managers, `channel.ts`/`user.ts`, `mumble-socket.ts`, transports, `tls-connect.ts`, `packet-*`, `encode-mumble-version*`,
`read-varint`, `mumbleproto/`, `scripts/fix-proto2-required.mjs`, `e2e/` (stock-Mumble docker tests), the nested `.github/`, rxjs, protobuf, pem.
`webrtc-voice.ts` logic moves into `VoiceConnection`. `region-rtt-probe.ts` (TCP part only) moves into `apps/hachiman-electron/src/main/`.

### apps/hachiman (shared UI)

- Stores: `serverStore` → `guildStore`; `channelStore`, `messagesStore` (keyed by channel UUID), `voiceStore` (global, one voice session), `userStore`, `oracleStore`, plus `presenceStore`/`memberStore` as needed. Stores mirror `HachimanClient` events and follow the CLAUDE.md selector rules.
- Services: one `HachimanClient` singleton driven by `oracleService` tokens (single-flight refresh, public `getAccessToken()`). Delete `ServersService`, `ConnectionManager`, `platformRegistry` and `IMumbleService`. Rewrite `ChannelsService`/`VoiceService`/`MessagesService` over the client. `JoinUriService` → invite-code handling.
- Components: `server-settings-dialog` becomes a full rewrite to guild settings (overview, roles, members, invites) plus channel permission overwrites. Delete `superuser-password-dialog`, `mumble-permissions.ts`, `server-key.ts` and the relay Health tab. `add-server-dialog`/`join-server-modal` become create/join guild. New: DM list + DM view, presence dots, role colors.

### apps/hachiman-electron / apps/hachiman-browser

Delete both `platforms/*/MumbleService.ts`. Electron drops `pem`, `@discordjs/opus`, `link-opus-prebuild.js`, the `NODE_TLS_REJECT_UNAUTHORIZED=0` dev flag and the electron-vite externals. It turns on `contextIsolation` and the preload bridge implements `IPlatformService`. The region probe and `probe-target-guard` (ports {443}) move into main. The browser drops the `node:events` alias and `/join` hash handling, and handles `/invite/<code>` routes.

### apps/oracle

Keep: OIDC/auth, users, password reset, regions (+ `placement.ts` scoring), the `media_nodes` gRPC with the `MediaNodesRepo` seam, and `invite` landing.
New: `/api/v1/*` REST (contract §4), `lib/events.ts` Redis publisher (`REDIS_URL` required, added to `.env.example`), `lib/permissions` usage via `@hachiman/client`.
Delete: everything in fixup #10.

## 3. Execution (parallel workers, shared working tree, disjoint file ownership)

Preparation already done on the branch: the module path rename, the client package rename + relinks, and this plan + contract.

| Worker | Owns (may edit) | Must not touch |
|---|---|---|
| **W1 oracle-api** | `apps/oracle/src/db/**`, `apps/oracle/drizzle/**`, `apps/oracle/src/app/api/v1/**`, `apps/oracle/src/lib/{api-helpers,auth-helpers,events,guilds,invites,…new}.ts`, `invite-signing.ts` (delete), `apps/oracle/.env.example`, `apps/oracle/package.json`, `next.config.ts` | other oracle libs/pages (W2) |
| **W2 oracle-demolition** | every other file under `apps/oracle/**` (dead libs/routes/pages, dashboard, grpc handlers for the new proto, `oidc-adapter.ts`, `/invite/[code]` page, docs) | W1's files |
| **W3 gateway** | `cmd/hachiman-gateway/**`, `pkg/permissions/**`, `pkg/coturn/**` | other Go dirs; only `go get` for go.mod |
| **W4 media** | `cmd/hachiman-media/**`, `pkg/media/**`, `pkg/voicetoken/**`, `pkg/management/**`, `pkg/oracleclient/**`, `pkg/mediaproto` (delete) | — |
| **W5 go-demolition** | delete `cmd/hachiman-control` + the dead pkgs; Dockerfiles, `.goreleaser.yml`, `.github/workflows/go.yml`, `apps/hachiman-server/{package.json,README.md,*.md}`, root `package.json` server scripts, `docker/**` | go.mod |
| **W6 client-lib** | `pkgs/hachiman-client/**` | — |
| **W7 ui-core** | `apps/hachiman/src/{services,stores,shared,hooks,lib}/**`, `App.tsx`, `index.ts`, `env.d.ts`, and the components `chat-area`, `channel-sidebar`, `member-list`, `voice-controls`, `nav-user`, `server-icon-rail`, `user-profile-popover`, `message-toolbar`, `oracle-*` | the management/social components (W8) |
| **W8 ui-management** (wave 2, after W7) | `server-settings-dialog` → guild settings, channel overwrites dialog, `add-server-dialog`/`join-server-modal` → create/join guild, `remove-server-dialog` → leave/delete, `create-channel-dialog`, DM UI, presence/role-color polish | — |
| **W9 hosts** | `apps/hachiman-electron/**`, `apps/hachiman-browser/**`, `pnpm-workspace.yaml` | shared UI |

After both waves:
- go mod tidy, full typecheck/build.
- The `webrtc-reviewer` agent on voice.
- An integration run (Postgres + Redis + Oracle + gateway + media).
- The naming sweep.
- CLAUDE.md/README/skills/agents updates.

## 4. Verification

- `tsgo` typecheck for every TS workspace. `CGO_ENABLED=0 go build ./... && go vet ./... && go test ./...`.
- `pkg/permissions` sync test (Go parses the TS constants). Oracle `pnpm test` (tsx scripts) including a permissions test.
- Gateway integration test (`cmd/hachiman-gateway`, build tag `integration`, needs `DATABASE_URL`/`REDIS_URL`/`ORACLE_URL`): identify → READY → REST message send → MESSAGE_CREATE arrives. Resume on a second gateway instance.
- Voice: two browser clients in one voice channel with audio both ways, using the verify/run skill (per `feedback_verify_skill_for_browser.md`).
- Final gate: `grep -riE 'mumble|murmur|grumble' --exclude-dir=node_modules --exclude-dir=.git .` returns nothing, except the history table of this plan and `apps/hachiman-server/{LICENSE,AUTHORS}`. Grumble is BSD-licensed, so its copyright notice **must stay**. The same applies to `pkgs/hachiman-client/LICENSE` if it carries upstream attribution.

Environment notes (from the audit session): `pnpm` cannot self-switch versions inside the Claude sandbox, so run `tsgo` directly (`node_modules/.bin/tsgo`). Go needs `GOCACHE=$TMPDIR/gocache CGO_ENABLED=0` in the sandbox. Docker is not reachable from the sandbox. **The user must run `pnpm install` once after the refactor** to refresh the lockfile (the workspace links were created by hand).
