# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this repo is

Hachiman is a Mumble voice-chat ecosystem in a pnpm monorepo: a TypeScript client library, a shared React UI, two host apps (Electron + Browser), and a Go server (a Grumble fork) with WebRTC SFU support.

## Monorepo layout

```
apps/
  hachiman/            @hachiman/hachiman           — shared React UI library (components, stores, services, platform abstraction)
  hachiman-electron/   @hachiman/hachiman-electron  — Electron host (native TLS + Opus via @discordjs/opus)
  hachiman-browser/    @hachiman/hachiman-browser   — Browser host (WebSocket + WebRTC voice)
  hachiman-server/     hachiman-server              — Go Mumble-compatible server (cmd/grumble + pkg/web SFU)

pkgs/
  hachiman-node/       @hachiman/hachiman-node      — Mumble client library (transports, channel/user managers, WebRTC voice, generated protobuf)
```

Host apps (`hachiman-electron`, `hachiman-browser`) depend on the shared UI library (`@hachiman/hachiman`) AND the client library (`@hachiman/hachiman-node`). The shared UI talks to Mumble through the `IMumbleService` / `IPlatformService` interfaces in `apps/hachiman/src/shared/`; each host implements those under its own `platforms/<host>/` directory.

## TypeScript: use tsgo, never tsc

**This repo uses the TypeScript-native compiler (`@typescript/native-preview`, binary name `tsgo`) for all TypeScript work.** It is declared as a root devDependency in `package.json` and is the compiler invoked by every package's `typecheck` and `build` scripts.

- ✅ `pnpm -F @hachiman/hachiman typecheck` (runs `tsgo --noEmit -p tsconfig.web.json --composite false`)
- ✅ `tsgo --noEmit` directly when iterating on one package
- ❌ Do not run `tsc` directly, do not add `tsc` to any new script, do not add `typescript` as a devDependency to any workspace package.

If you add a new TypeScript package or a new `build`/`typecheck` script, mirror the existing pattern and invoke `tsgo`. The only place `tsc-alias` is used is in `pkgs/hachiman-node/package.json`'s `build` script to rewrite path aliases after `tsgo` emits — `tsc-alias` ≠ `tsc`, leave it alone.

## Common commands

Run from the repo root unless noted.

```bash
# Install everything
pnpm install

# Dev (parallel across all workspaces that define a `dev` script)
pnpm dev

# Dev — individual targets
pnpm dev:server          # Go server with nodemon hot-reload (apps/hachiman-server)
pnpm dev:electron        # Electron app
pnpm dev:browser         # Browser app on Vite

# Build
pnpm build:server
pnpm build:electron
pnpm build:browser

# Typecheck a single workspace (always tsgo under the hood)
pnpm -F @hachiman/hachiman          typecheck
pnpm -F @hachiman/hachiman-electron typecheck   # runs typecheck:node + typecheck:web
pnpm -F @hachiman/hachiman-browser  typecheck
pnpm -F @hachiman/hachiman-node     build       # no separate typecheck; build emits

# Lint / format
pnpm -F <package> lint
pnpm -F <package> format

# Tests (only hachiman-node has them)
pnpm -F @hachiman/hachiman-node test
pnpm -F @hachiman/hachiman-node test:e2e

# Regenerate protobuf bindings after editing .proto files
pnpm -F @hachiman/hachiman-node generate-proto
```

Server port is **64738** (TCP + UDP + WebSocket on the same port).

**Dev DB schema churn:** during phase 1 of the media-plane split, schemas on both sides are still moving. Per `feedback_dev_migrations.md`, drop the dev DB and reseed instead of stacking ALTERs — for Postgres use `pnpm -F @hachiman/oracle db:migrate` after wiping the schema; for the SQLite control DB just delete `$DATADIR/murmur.sqlite` and restart so `Init()` reseeds (the `Hachiman-Standard` quality profile lands automatically).

## Working in the shared UI (`apps/hachiman/src/`)

This is where most React work lands. Layout: `components/`, `stores/` (Zustand), `services/` (singleton services bridging stores ↔ `IMumbleService`), `shared/` (platform-abstraction interfaces).

### Zustand selector conventions

The codebase had an infinite-render bug from sloppy selectors; follow these rules to avoid reintroducing it.

- **Single-value selectors**: read one field, no fallback that allocates.
  ```ts
  const selectedServerId = useServerStore((s) => s.selectedServerId)
  ```
- **Object destructures**: wrap in `useShallow`, never destructure the whole store.
  ```ts
  import { useShallow } from 'zustand/react/shallow'
  const { servers, selectedServerId } = useServerStore(
    useShallow((s) => ({ servers: s.servers, selectedServerId: s.selectedServerId }))
  )
  ```
- **Empty-collection fallbacks**: hoist a module-level constant; never return `[]`/`{}` literals from a selector.
  ```ts
  const EMPTY_MESSAGES: Message[] = []
  const messages = useMessageStore((s) =>
    channelId !== null ? (s.history.get(channelId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )
  ```

A fresh array/object literal returned from a selector triggers React's "getSnapshot should be cached to avoid an infinite loop" warning and breaks the renderer.

### Other UI conventions

- Tooltips: there is **one** `TooltipProvider` at the App root (`App.tsx`). Don't nest more — Radix tolerates it but the delay gets shadowed and behaviour gets inconsistent.
- `NavUser` uses plain markup + `useIsMobile()`; do **not** reach for `useSidebar()` / `SidebarMenu*` from `components/ui/sidebar.tsx` — those require a `SidebarProvider` that isn't mounted anywhere.
- `userData` should come from `useUserStore`, not hardcoded.

## Working in the client library (`pkgs/hachiman-node`)

Editing `.proto` files (`Mumble.proto`, `MumbleUDP.proto`) requires regenerating bindings on **both** sides — the TypeScript bindings in this package AND the Go bindings in `apps/hachiman-server/pkg/mumbleproto/`. Use the `regen-proto` skill or run `pnpm -F @hachiman/hachiman-node generate-proto` and the server's equivalent. The protobuf source lives under the server's `pkg/mumbleproto/`; this package's script reaches across to it.

When adding a new Mumble control-channel message type, use the `add-mumble-message` skill — there's a fixed multi-file checklist (proto, registry, Go server, TS client) and it's easy to miss a step.

## Working in the Go server (`apps/hachiman-server`)

Run from the package directory or via `pnpm dev:server` / `pnpm build:server`. Key areas:
- `cmd/hachiman-control/` — control plane: auth, channels, ACL, text messages, WebRTC signaling shim, placement, sidechannel listener
- `cmd/hachiman-media/` — stateless WebRTC SFU (split per phase 1 of the media-plane migration)
- `cmd/hachiman-recorder/` — recording subscriber scaffold (phase 3a; segment writes land in phase 4)
- `pkg/media/` — SFU primitives (SSRC pool, peer connection wiring) — imported only by hachiman-media
- `pkg/mediaproto/`, `pkg/recorderproto/` — control↔media and media↔recorder sidechannel protos
- `pkg/mumbleproto/` — Mumble client protocol (authoritative for both server and client)
- `pkg/database/` — GORM + SQLite/Postgres persistence
- `pkg/oracleclient/` — wrapper around Oracle's GrumbleManagement gRPC (RegisterMediaNode / MediaNodeHeartbeat / PlaceMediaSession)
- `pkg/coturn/` — per-region TURN credential minting (HMAC-SHA1, coturn REST API scheme)
- `pkg/acl/` — permissions

Containerization (phase 3a): three Dockerfiles per arch — `Dockerfile.control`, `Dockerfile.media`, `Dockerfile.recorder` (amd64); `Dockerfile.arm32v6.control`, `.media`, `.recorder`. Each builds exactly one binary; control is the only one with a `/data` VOLUME.

For changes to the SFU stack or the UDP↔WebRTC bridge, use the `webrtc-reviewer` agent — there's a class of SSRC pool / renegotiation race bugs that a generic review will miss.

## Working in Oracle (`apps/oracle`)

Two processes:
- The Next.js app (`pnpm dev`) — OIDC, OAuth, dashboard UI, REST API.
- A standalone gRPC server (`pnpm dev:grpc`) — implements the media-plane RPCs (`RegisterMediaNode`, `MediaNodeHeartbeat`, `PlaceMediaSession`) that hachiman-control consumes. Lives separately because Next has no clean "after listen" hook and a colocated gRPC port would flap on every dev file-watcher restart.

Both processes share the same Postgres DB via Drizzle; the proto source of truth is `apps/hachiman-server/pkg/management/management.proto` and Oracle's gRPC server loads it dynamically via `@grpc/proto-loader` (no generated TS bindings).

Storage seam: `apps/oracle/src/grpc/repo.ts` defines `MediaNodesRepo`, the narrow interface every media-plane handler uses for DB access. Production wires Drizzle via `drizzleMediaNodesRepo`; tests inject `InMemoryMediaNodesRepo` (`repo.in-memory.ts`) so the same handler code paths exercise without `DATABASE_URL`. When adding a new RPC that touches `media_nodes`, add a method to `MediaNodesRepo` and update BOTH implementations in lockstep — duplicating the SQL outside the repo (the old `placement-rank.ts` antipattern) lets the test and production paths drift silently.

Oracle gRPC security posture: the server binds **loopback by default** (`127.0.0.1`) because `RegisterMediaNode` / `MediaNodeHeartbeat` / `PlaceMediaSession` currently have NO application-layer auth. Operators who need an external bind set `ORACLE_GRPC_BIND_ADDR` explicitly; the server logs a prominent warning at startup. mTLS lands with Phase 5 cert provisioning (paired with the Go-side follow-up #10 in `pkg/oracleclient/client.go`).

## Architecture references

The top-level `README.md` has mermaid diagrams for: connection flow, voice routing (native UDP ↔ WebRTC SFU bridge), and the Electron app's internal store/service/component layout. Skim those before larger changes — they capture the relationships text won't.

## Don'ts

- Don't reintroduce `tsc` or a `typescript` devDependency anywhere — use `tsgo`.
- Don't return fresh array/object literals from Zustand selectors.
- Don't edit `Mumble.pb.go` or `pkgs/hachiman-node/src/mumbleproto/*.ts` by hand; regenerate.
- Don't nest `TooltipProvider`s — there's already one at the App root.
- Don't add features beyond what the task requires; the UI is in active flux toward a Discord-like layout and unrelated refactors create merge churn.
