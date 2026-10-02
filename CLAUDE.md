# CLAUDE.md

Guidance for Claude Code when it works in this repository.

## What this repo is

Hachiman is guild-based voice and text chat with a Discord-style architecture, in a pnpm monorepo. The monorepo contains:

- Takusen (Next.js identity + REST API + Postgres schema)
- a Go gateway fleet (WebSocket events) and Go media nodes (WebRTC SFU)
- a browser-safe TypeScript client library
- a shared React UI
- two host apps (Electron + Browser)

Postgres holds durable data. Redis holds sessions, presence, voice state and the event bus.

The wire contract for every process boundary is **`docs/gateway-protocol.md`**. It covers entity shapes, permissions, schema, REST routes, Redis keys, gateway ops, voice token, media voice WS, management proto, client API and platform seam. If code and the contract disagree, fix one of them in the same change. `docs/discord-refactor.md` records the design decisions.

## Monorepo layout

```
apps/
  takusen/              @hachiman/takusen             — Next.js: OIDC, REST /api/v1, Drizzle schema, Redis publisher; separate gRPC process for media registry + placement
  hachiman/            @hachiman/hachiman           — shared React UI library (components, stores, services, platform abstraction)
  hachiman-electron/   @hachiman/hachiman-electron  — Electron host (preload bridge implements IPlatformService, region probe in main)
  hachiman-browser/    @hachiman/hachiman-browser   — Browser host (Vite)
  hachiman-server/     hachiman-server              — Go module hachiman/server: hachiman-gateway, hachiman-media, hachiman-recorder

pkgs/
  hachiman-client/     @hachiman/client             — browser-safe client library (RestClient, GatewayClient, VoiceConnection, HachimanClient, permissions, types)
```

Host apps (`hachiman-electron`, `hachiman-browser`) depend on the shared UI library (`@hachiman/hachiman`) AND the client library (`@hachiman/client`). The shared UI owns the one `HachimanClient` (`apps/hachiman/src/services/hachiman.ts`). Hosts only implement `IPlatformService` (`apps/hachiman/src/shared/IPlatformService.ts`) under their own `platforms/<host>/` or preload code.

## TypeScript: use tsgo, never tsc

**This repo uses the TypeScript-native compiler (`@typescript/native-preview`, binary name `tsgo`) for all TypeScript work.** The root `package.json` declares it as a devDependency. The `typecheck` and `build` scripts of every package invoke it.

- ✅ `pnpm -F @hachiman/hachiman typecheck` (runs `tsgo --noEmit -p tsconfig.web.json --composite false`)
- ✅ `tsgo --noEmit` directly when you iterate on one package
- ❌ Do not run `tsc` directly. Do not add `tsc` to any new script. Do not add `typescript` as a devDependency to any workspace package.

If you add a new TypeScript package or a new `build`/`typecheck` script, mirror the existing pattern and invoke `tsgo`. Consumers use `@hachiman/client` as TypeScript source (no emit step).

## Common commands

Run from the repo root unless noted.

```bash
# Install everything
pnpm install

# One env file for all services: copy the template, then set the REQUIRED values
cp .env.example .env

# Backing services (Postgres, Redis, SeaweedFS S3 on :8333)
docker compose -f docker/docker-compose.yml up -d

# Dev (parallel across all workspaces that define a `dev` script)
pnpm dev

# Dev — individual targets
pnpm dev:takusen                    # Takusen Next.js on :3000 + management gRPC on 127.0.0.1:50051
pnpm -F @hachiman/takusen dev:grpc  # only the management gRPC
pnpm dev:server                    # gateway (:8080) + media (:8090) with nodemon hot-reload; reads DATABASE_URL from the root .env
pnpm dev:gateway                   # gateway only
pnpm dev:media                     # media only
pnpm dev:electron                  # Electron app
pnpm dev:browser                   # Browser app on Vite

# Takusen DB (root shortcuts for `pnpm -F @hachiman/takusen <script>`)
pnpm db:migrate
pnpm db:seed
pnpm db:reset                 # empty the dev DB (refuses NODE_ENV=production), then migrate + seed
pnpm sessions:revoke          # sign every user out (dashboard cookies + OIDC sessions and tokens)
pnpm admin:grant <email>      # make an existing user a deployment admin (admin API: /api/admin, contract §4)

# Build
pnpm build:server
pnpm build:electron
pnpm build:browser

# Typecheck a single workspace (always tsgo under the hood)
pnpm -F @hachiman/hachiman          typecheck
pnpm -F @hachiman/hachiman-electron typecheck   # runs typecheck:node + typecheck:web
pnpm -F @hachiman/hachiman-browser  typecheck
pnpm -F @hachiman/client            typecheck
pnpm -F @hachiman/takusen            typecheck

# Lint / format
pnpm -F <package> lint
pnpm -F <package> format

# Tests
pnpm -F @hachiman/client test              # vitest
pnpm -F @hachiman/takusen test              # tsx scripts incl. gRPC handlers (no DB needed)
pnpm -F @hachiman/hachiman-electron test   # main-process unit tests
cd apps/hachiman-server && go test ./...   # gateway, media, permissions, voicetoken, ...
# gateway integration test: build tag `integration`, needs DATABASE_URL / REDIS_URL / TAKUSEN_URL
```

**Environment:** local dev uses one file, the repo-root `.env`. The template is the repo-root `.env.example`. It has a `# MARK: -` section for each service (Shared, Object storage, Takusen, Gateway, Media, Desktop / Web). There are no per-project env files. Each runner loads the root file and keeps a variable that is already set in the real environment:

- Takusen Next.js and `drizzle.config.ts`: `process.loadEnvFile` in the config. Next.js also auto-loads `apps/takusen/.env*`. Do not keep env files there, because they shadow the root file.
- Takusen tsx scripts (`dev:grpc`, `start:grpc`, `db:migrate`, `db:seed`, `db:reset`, `sessions:revoke`, `admin:grant`): `--env-file-if-exists=../../.env`.
- Gateway and media (`pnpm dev:server`): `node --env-file-if-exists=../../.env` runs nodemon, and `go run` gets the same environment. All runners use one parser (Node's), so a line in `.env` gives the same value everywhere.
- Vite (browser, and the Electron main, preload and renderer): `envDir` is the repo root.

One name has one meaning in the shared file. Give a new variable a service prefix (`GATEWAY_`, `MEDIA_`, `TAKUSEN_GRPC_`, `VITE_`) unless more than one service reads it. Add each new variable to `.env.example`.

**Dev DB schema churn:** schemas still change. Per `feedback_dev_migrations.md`, drop the dev DB and reseed instead of stacking ALTERs. Postgres is the only database. Run `pnpm db:reset`: it drops the schemas, migrates, and seeds the `hachiman-client` OIDC client and the regions.

## Working in the shared UI (`apps/hachiman/src/`)

Most React work lands here. Layout:

- `components/`
- `stores/` (Zustand)
- `services/`: `hachiman.ts` owns the `HachimanClient` singleton and mirrors its cache into the stores. `MessagesService` / `VoiceService` / `InviteService` / `TakusenService` sit on top.
- `shared/` (platform-abstraction interfaces)

### Zustand selector conventions

The codebase had an infinite-render bug from sloppy selectors. Obey these rules so that the bug does not come back.

- **Single-value selectors**: read one field, no fallback that allocates.
  ```ts
  const selectedGuildId = useGuildStore((s) => s.selectedGuildId)
  ```
- **Object destructures**: wrap in `useShallow`, never destructure the whole store.
  ```ts
  import { useShallow } from 'zustand/react/shallow'
  const { guilds, selectedGuildId } = useGuildStore(
    useShallow((s) => ({ guilds: s.guilds, selectedGuildId: s.selectedGuildId }))
  )
  ```
- **Empty-collection fallbacks**: hoist a module-level constant. Never return `[]`/`{}` literals from a selector.
  ```ts
  const EMPTY_MESSAGES: ChatMessage[] = []
  const messages = useMessageStore((s) =>
    channelId !== null ? (s.byChannel.get(channelId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  ```

If a selector returns a fresh array/object literal, React shows the warning "getSnapshot should be cached to avoid an infinite loop", and the renderer breaks.

### Other UI conventions

- Tooltips: there is **one** `TooltipProvider` at the App root (`App.tsx`). Do not nest more. Radix tolerates it, but the delay gets shadowed and the behavior becomes inconsistent.
- `NavUser` uses plain markup + `useIsMobile()`. Do **not** use `useSidebar()` / `SidebarMenu*` from `components/ui/sidebar.tsx`. Those require a `SidebarProvider`, and no code mounts one.
- `userData` should come from `useUserStore`, not hardcoded.

## Working in the client library (`pkgs/hachiman-client`)

Browser-safe only (`fetch`, `WebSocket`, `RTCPeerConnection`): no Node imports, no rxjs, no protobuf. The wire contract lives in `docs/gateway-protocol.md` (§10 is the API of this package). There are no generated bindings.

- **Permissions**: each language defines them once. TS: `pkgs/hachiman-client/src/permissions.ts`. Go: `apps/hachiman-server/pkg/permissions/permissions.go`. `pkg/permissions/sync_test.go` parses the TS file and fails on any name/value mismatch. Change both together.
- **Adding a gateway event**: one change must include all of these:
  - the contract (§6, plus §4/§5 if REST publishes it)
  - `GatewayEvents` in `pkgs/hachiman-client/src/types.ts` (and the `HachimanClient` cache if the event mutates state)
  - the Takusen publish call (`apps/takusen/src/lib/events.ts` callers)
  - the gateway handling in `cmd/hachiman-gateway` (dispatch/visibility filtering)
- The `regen-proto` skill and its sibling message-type skill in `.claude/skills` are obsolete (they target the deleted protobuf protocol). Their removal is pending. Do not use them.

## Working in the Go server (`apps/hachiman-server`)

Go module `hachiman/server`. Run from the package directory or through `pnpm dev:server` / `pnpm build:server`. Key areas:
- `cmd/hachiman-gateway/` — stateless WebSocket gateway: HELLO/IDENTIFY/RESUME, Redis event dispatch with VIEW_CHANNEL filtering, presence, voice join + voice-token minting
- `cmd/hachiman-media/` — stateless WebRTC SFU: voice WS (`/voice`), token verification, Takusen registration/heartbeat, Redis `media:{nodeId}` kicks
- `cmd/hachiman-recorder/` — recording subscriber scaffold (not wired to media)
- `pkg/media/` — SFU primitives (SSRC pool, peer connection wiring). Only hachiman-media imports it.
- `pkg/voicetoken/` — PASETO voice token: `Signer` (gateway), `Verifier` (media)
- `pkg/permissions/` — Go half of the permission lib (+ `sync_test.go` against the TS file)
- `pkg/coturn/` — per-region TURN credential minting (HMAC-SHA1, coturn REST API scheme) for `iceServers`
- `pkg/management/` — Takusen management gRPC proto (`hachiman.management.v1`) + generated code. Regenerate with `go generate` in that directory. Never hand-edit `*.pb.go`.
- `pkg/takusenclient/` — wrapper around the Takusen `Management` gRPC (RegisterMediaNode / MediaNodeHeartbeat / PlaceMediaSession)
- `pkg/recorderproto/` — media↔recorder proto (scaffold)

Containerization: `Dockerfile.gateway`, `Dockerfile.media`, `Dockerfile.recorder` (amd64) and the `Dockerfile.arm32v6.*` variants. Each builds exactly one binary.

For changes to the voice stack (`pkg/media`, `cmd/hachiman-media/voice.go`, `pkgs/hachiman-client/src/voice.ts`), use the `webrtc-reviewer` agent. There is a class of SSRC pool / renegotiation race bugs that a generic review will miss.

## Working in Takusen (`apps/takusen`)

Two processes:
- The Next.js app (`pnpm dev`) — OIDC, OAuth, dashboard UI, REST API (`src/app/api/v1`). Every REST mutation publishes its gateway event to Redis after the DB commit (`src/lib/events.ts`).
- A standalone gRPC server (`pnpm dev:grpc`) — implements the media-plane RPCs (`RegisterMediaNode`, `MediaNodeHeartbeat`, `PlaceMediaSession`) that hachiman-media and hachiman-gateway consume. It is a separate process because Next has no clean "after listen" hook. A colocated gRPC port would flap on every dev file-watcher restart.

Both processes share the same Postgres DB through Drizzle. The proto source of truth is `apps/hachiman-server/pkg/management/management.proto`. The Takusen gRPC server loads it dynamically through `@grpc/proto-loader` (no generated TS bindings).

Storage seam: `apps/takusen/src/grpc/repo.ts` defines `MediaNodesRepo`. This is the narrow interface that every media-plane handler uses for DB access. Production wires Drizzle through `drizzleMediaNodesRepo`. Tests inject `InMemoryMediaNodesRepo` (`repo.in-memory.ts`), so the same handler code paths run without `DATABASE_URL`. When you add a new RPC that touches `media_nodes`, add a method to `MediaNodesRepo` and update BOTH implementations in lockstep. If you copy the SQL outside the repo (the old `placement-rank.ts` antipattern), the test and production paths drift silently.

Takusen gRPC security posture: the server binds **loopback by default** (`127.0.0.1`). The reason is that `RegisterMediaNode` / `MediaNodeHeartbeat` / `PlaceMediaSession` currently have NO application-layer auth. Operators who need an external bind set `TAKUSEN_GRPC_BIND_ADDR` explicitly. The server then logs a prominent warning at startup. mTLS lands with Phase 5 cert provisioning (paired with the Go-side follow-up #10 in `pkg/takusenclient/client.go`).

## Architecture references

The top-level `README.md` has mermaid diagrams for: component topology, connection + event flow, voice join, and the store/service/component layout of the shared UI. Skim those before larger changes. They capture relationships that text does not.

## Don'ts

- Do not reintroduce `tsc` or a `typescript` devDependency anywhere. Use `tsgo`.
- Do not return fresh array/object literals from Zustand selectors.
- Do not edit `*.pb.go` by hand. Regenerate with `go generate`.
- Do not change a wire shape without an update to `docs/gateway-protocol.md` in the same change.
- Do not nest `TooltipProvider`s. There is already one at the App root.
- Do not add features beyond what the task requires. The UI is in active flux toward a Discord-like layout, and unrelated refactors create merge churn.
