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
- `cmd/grumble/` — entry point, packet handlers, voice broadcast
- `pkg/web/` — WebRTC SFU, SSRC pool, browser bridge
- `pkg/mumbleproto/` — protobuf definitions (authoritative for both server and client)
- `pkg/database/` — GORM + SQLite persistence
- `pkg/acl/`, `pkg/cryptstate/` — permissions and voice encryption

For changes to the SFU stack or the UDP↔WebRTC bridge, use the `webrtc-reviewer` agent — there's a class of SSRC pool / renegotiation race bugs that a generic review will miss.

## Architecture references

The top-level `README.md` has mermaid diagrams for: connection flow, voice routing (native UDP ↔ WebRTC SFU bridge), and the Electron app's internal store/service/component layout. Skim those before larger changes — they capture the relationships text won't.

## Don'ts

- Don't reintroduce `tsc` or a `typescript` devDependency anywhere — use `tsgo`.
- Don't return fresh array/object literals from Zustand selectors.
- Don't edit `Mumble.pb.go` or `pkgs/hachiman-node/src/mumbleproto/*.ts` by hand; regenerate.
- Don't nest `TooltipProvider`s — there's already one at the App root.
- Don't add features beyond what the task requires; the UI is in active flux toward a Discord-like layout and unrelated refactors create merge churn.
