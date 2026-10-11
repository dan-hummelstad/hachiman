# CLAUDE.md

Guidance for Claude Code when it works in this repository.

## What this repo is

Hachiman is guild-based voice and text chat, with collaborative markdown pages, in a Discord-style architecture, in a pnpm monorepo. The monorepo contains:

- Takusen (Next.js identity + REST API + file storage + Postgres schema + the E2EE delivery service)
- a Go gateway fleet (WebSocket events) and Go media nodes (WebRTC SFU for voice and screen share)
- a browser-safe TypeScript client library
- a browser-safe E2EE library (MLS through ts-mls, message envelopes, attachments, SFrame)
- a shared React UI
- three host apps (Electron, Browser and iOS)

Postgres holds durable data. S3 (SeaweedFS in dev) holds file bytes, and only Takusen talks to it. Redis holds sessions, the resume buffer, presence, voice state and the event bus.

Every channel type uses end-to-end encryption (E2EE): DMs, guild text, pages, voice, video and screen share. There is no plaintext mode. Takusen, the gateway and the media nodes relay only ciphertext. Only member devices hold keys.

The wire contract for every process boundary is **`docs/gateway-protocol.md`**. It covers entity shapes, permissions, schema, REST routes, Redis keys, gateway ops, voice token, media voice WS, management proto, client API, platform seam and E2EE. If code and the contract disagree, fix one of them in the same change. `docs/discord-refactor.md` records the design decisions. `docs/e2ee-plan.md` gives the reasons for the E2EE design. `docs/pages-channels-plan.md` gives the reasons for the pages channel design. `docs/ui-redesign.md` is the UI spec.

## Monorepo layout

```
apps/
  takusen/            @hachiman/takusen            — Next.js: OIDC, REST /api/v1, uploads/files (S3), E2EE delivery service (src/lib/mls), pages storage (src/lib/docs), Drizzle schema, Redis publisher; separate gRPC process for media registry + placement, MLS batch scheduler, KT tree heads
  hachiman/            @hachiman/hachiman           — shared React UI library (components, stores, services, hooks, platform abstraction, ?preview mode)
  hachiman-electron/   @hachiman/hachiman-electron  — Electron host (main: CSP, deep links, region probe, screen picker; preload bridge; renderer PlatformService)
  hachiman-browser/    @hachiman/hachiman-browser   — Browser host (Vite)
  hachiman-ios/        @hachiman/hachiman-ios       — iOS host (SwiftUI + WKWebView serving the shared UI from hachiman://app; Swift bridge for the Keychain wrap key, OAuth, haptics, share, QR scan)
  hachiman-server/     hachiman-server              — Go module hachiman/server: hachiman-gateway, hachiman-media, hachiman-recorder (scaffold)

pkgs/
  hachiman-client/     @hachiman/client             — browser-safe client library (RestClient, GatewayClient, VoiceConnection, HachimanClient, permissions, files, types)
  hachiman-crypto/     @hachiman/crypto             — E2EE (ts-mls): crypto Worker, identity, MLS groups, envelopes, attachments, SFrame transform Worker, encrypted store; `./ds` entry for Takusen
```

Host apps (`hachiman-electron`, `hachiman-browser`, `hachiman-ios`) depend only on the shared UI library (`@hachiman/hachiman`), which depends on the client library (`@hachiman/client`) and the crypto library (`@hachiman/crypto`). Hosts do not import `@hachiman/client` or `@hachiman/crypto`. The shared UI owns the one `HachimanClient` (`apps/hachiman/src/services/hachiman.ts`). Hosts only implement `IPlatformService` (`apps/hachiman/src/shared/IPlatformService.ts`): Electron in `src/renderer/src/PlatformService.ts` (a thin adapter over the preload bridge `window.hachiman`), the browser in `src/platforms/browser/PlatformService.ts`, iOS in `src/platforms/ios/PlatformService.ts` (over the WKWebView script message bridge). A new seam method needs all three implementations, the preload bridge, an IPC channel in `apps/hachiman-electron/src/shared/ipc.ts`, and an iOS bridge op when iOS implements it natively.

Workspace dependency direction: `@hachiman/crypto` depends on `@hachiman/client` (only for `@hachiman/client/permissions`, in `src/worker/`). `@hachiman/client` never imports `@hachiman/crypto`. Its E2EE types mirror the crypto types structurally. Takusen loads `@hachiman/crypto/ds` through one file, `apps/takusen/src/lib/mls/crypto.ts`.

## TypeScript: use tsgo, never tsc

**This repo uses the TypeScript-native compiler (`@typescript/native-preview`, binary name `tsgo`) for all TypeScript work.** The root `package.json` declares it as a devDependency. The `typecheck` and `build` scripts of every package invoke it.

- ✅ `pnpm -F @hachiman/hachiman typecheck` (runs `tsgo --noEmit -p tsconfig.web.json --composite false`)
- ✅ `tsgo --noEmit` directly when you iterate on one package
- ❌ Do not run `tsc` directly. Do not add `tsc` to any new script. Do not add `typescript` as a devDependency to any workspace package.

If you add a new TypeScript package or a new `build`/`typecheck` script, mirror the existing pattern and invoke `tsgo`. Consumers use `@hachiman/client` and `@hachiman/crypto` as TypeScript source (no emit step).

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
pnpm build:server                  # gateway + media into apps/hachiman-server/bin (the recorder builds only from its Dockerfile)
pnpm build:electron
pnpm build:browser
pnpm -F @hachiman/hachiman-ios build      # the iOS web bundle (dist/); then xcodegen + Xcode (apps/hachiman-ios/README.md)

# Typecheck a single workspace (always tsgo under the hood)
pnpm -F @hachiman/hachiman          typecheck
pnpm -F @hachiman/hachiman-electron typecheck   # runs typecheck:node + typecheck:web
pnpm -F @hachiman/hachiman-browser  typecheck
pnpm -F @hachiman/hachiman-ios      typecheck
pnpm -F @hachiman/client            typecheck
pnpm -F @hachiman/crypto            typecheck   # tsgo --noEmit -p tsconfig.json
pnpm -F @hachiman/takusen            typecheck   # incremental (tsbuildinfo): if results look stale, run
                                                 # tsgo --noEmit --incremental false -p apps/takusen/tsconfig.json

# Lint / format
pnpm -F <package> lint
pnpm -F <package> format

# Tests
pnpm -F @hachiman/client test              # vitest
pnpm -F @hachiman/hachiman test            # vitest: shared UI services, hooks and helpers (src/dev/vitest.config.ts)
pnpm -F @hachiman/crypto test              # vitest (node environment, fake-indexeddb), incl. the ts-mls smoke spec
pnpm -F @hachiman/takusen test              # tsx scripts incl. gRPC handlers and the DS (no DB needed)
pnpm -F @hachiman/hachiman-electron test   # main-process unit tests (CSP, secure storage, ...)
pnpm -F @hachiman/hachiman-browser test    # CSP and secure storage (node --test)
pnpm -F @hachiman/hachiman-ios test        # CSP, bridge, native events, PlatformService (node --test)
cd apps/hachiman-ios && xcodegen generate && xcodebuild test -project Hachiman.xcodeproj -scheme Hachiman -destination 'platform=iOS Simulator,name=iPhone 16,OS=latest'   # XCTest; needs a signed (ad hoc) build and developer mode
cd apps/hachiman-server && go test ./...   # gateway, media (incl. the E2EE relay), permissions, voicetoken, ...
# gateway integration test: build tag `integration`, needs DATABASE_URL / REDIS_URL / TAKUSEN_URL

# Inside the Claude sandbox (pnpm does not run there)
cd pkgs/hachiman-crypto && node_modules/.bin/vitest run
cd pkgs/hachiman-crypto && ../../node_modules/.bin/tsgo --noEmit -p tsconfig.json
cd apps/hachiman && ../../pkgs/hachiman-client/node_modules/.bin/vitest run --config src/dev/vitest.config.ts   # shared UI unit tests
```

**Environment:** local dev uses one file, the repo-root `.env`. The template is the repo-root `.env.example`. It has a `# MARK: -` section for each service (Shared, Object storage, Takusen, Gateway, Media, Desktop / Web, Production only). There are no per-project env files. Each runner loads the root file and keeps a variable that is already set in the real environment:

- Takusen Next.js and `drizzle.config.ts`: `process.loadEnvFile` in the config. Next.js also auto-loads `apps/takusen/.env*`. Do not keep env files there, because they shadow the root file.
- Takusen tsx scripts (`dev:grpc`, `start:grpc`, `db:migrate`, `db:seed`, `db:reset`, `sessions:revoke`, `admin:grant`): `--env-file-if-exists=../../.env`.
- Gateway and media (`pnpm dev:server`): `node --env-file-if-exists=../../.env` runs nodemon, and `go run` gets the same environment. All runners use one parser (Node's), so a line in `.env` gives the same value everywhere.
- Vite (browser, and the Electron main, preload and renderer): `envDir` is the repo root.

One name has one meaning in the shared file. Give a new variable a service prefix (`GATEWAY_`, `MEDIA_`, `TAKUSEN_GRPC_`, `VITE_`) unless more than one service reads it. Add each new variable to `.env.example`.

E2EE variables (contract §12.18):

- Takusen: `TAKUSEN_DS_SIGNING_KEY` and `TAKUSEN_KT_SIGNING_KEY` (Ed25519 seed files, relative to `apps/takusen`). The first process that finds no file creates it with mode 0600. All Takusen instances must share the files.
- Takusen: `TAKUSEN_MLS_SUITES` (default `1`), `TAKUSEN_MAX_ENVELOPE_BYTES` (default 32768), `TAKUSEN_PUBLIC_SET_MAX_MEMBERS` (default 500, set by the load test in `docs/e2ee-load-test.md`), `TAKUSEN_MLS_BATCH_INTERVAL_MS` (default 2000), `TAKUSEN_MLS_BATCH_TIMEOUT_MS` (default 5000), `TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES` (default 104857600), `TAKUSEN_GUILD_PAGE_STORAGE_BYTES` (default 10737418240, 0 = no limit).
- Gateway: `GATEWAY_MIN_CLIENT_VERSION` (default `0.1.0`). IDENTIFY with an older `clientVersion` gets close 4012.
- Media: `MEDIA_WS_READ_LIMIT` (default 1048576). The voice WebSocket rejects larger frames. Commits, Welcomes and ratchet trees use this socket.

**Schema changes: stack migrations.** For each schema change, edit `apps/takusen/src/db/schema.ts`, run `pnpm -F @hachiman/takusen db:generate`, and commit the new SQL file and `drizzle/meta/` with the schema change. Do not edit, delete or regenerate a committed migration. Deployed databases apply the new migrations with `db:migrate`, so a migration must work on a database that has data: give a new NOT NULL column a default or a backfill. Postgres is the only database. `pnpm db:reset` empties a local dev DB, then migrates and seeds the `hachiman-client` OIDC client and the regions. Use it to clear dev data, not to apply a schema change.

## Working in the shared UI (`apps/hachiman/src/`)

Most React work lands here. Layout:

- `components/`: `shell/` (the sidebar and its slots, the tab bar, the quick switcher, the recent DM and guild tile rows, the content card), `chat/`, `voice/` (incl. screen share and call security), `people/`, `settings/`, `docs/` (the pages panel, the Milkdown Crepe editor, page links, page media), `security/` (`CryptoGate` onboarding in front of the shell, the QR encoder `qr.ts`, and the security dialogs: devices, verification, linking, key change, recovery, fatal screens), `inbox/`, `events/`, `threads/`, `pins/`, `notify/`, `mobile/` (the mobile kit: sheet, pushed screen, nav bar, list rows, field, used only under the mobile layout of `hooks/use-layout.ts`, `<html data-layout>` and the `mobile:` variant), `ui/` (shadcn and Arc primitives). Settings are in the sidebar: `settings/settings-nav.tsx` in the sidebar middle, `settings/settings-page.tsx` in the content card
- `stores/` (Zustand): guild, channel, messages, voice, user, takusen, prefs, limits, nav, dialog, crypto, docs, tabs, unread, composer, pins, events, threads
- `services/`: `hachiman.ts` owns the `HachimanClient` singleton and mirrors its cache into the stores. `App.tsx` calls `startHachiman(platform)`: the crypto Worker does not start without the platform (it needs `secureStorage` for the wrap key). `MessagesService` / `VoiceService` / `InviteService` / `UploadService` / `TakusenService` sit on top. `SoundService` plays event chimes (`lib/sounds.ts` lists the events) as `prefsStore` permits. `UnreadService` keeps the read state and counts mentions on the client. `guild-features.ts` holds the pins, events, threads and blocks services.
- `services/CryptoService.ts` owns the one `CryptoClient` (the crypto Worker) and mirrors its events into `cryptoStore`. `ds-transport.ts` serves the Worker's REST calls. `message-decrypt.ts` decrypts messages. `voice-e2ee.ts` is the voice delegate. `AdminActionService` signs admin changes. `services/docs/` holds the pages data layer: `DocsService` (the page tree and titles) and `DocProvider` (one Yjs `Y.Doc` and awareness per open page: load, batch, encrypt, send, gap fill, snapshots).
- `hooks/`, `lib/` (helpers: mentions, stream quality, connection quality, sounds, ...)
- `shared/`: `IPlatformService.ts` (the seam), `PlatformContext.tsx`, `takusen-env.ts`
- `dev/preview/`: the `?preview` mode (Vite dev only). Stubbed REST and gateway data drive the UI with no backend. Use it for UI checks. See `dev/README.md`.

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
- The sidebar is `components/shell/sidebar.tsx`, plain markup. There is no shadcn sidebar component, and no code mounts a `SidebarProvider`. Do not add one.
- `userData` should come from `useUserStore`, not hardcoded.

### E2EE rules in the UI

- Decrypt before store. Every ciphertext `Message` goes through the crypto Worker (`services/message-decrypt.ts`). Only the result goes into `messagesStore`. Never store or show an envelope as text.
- Attachments show as object URLs of decrypted blobs (`hooks/use-decrypted-blob.ts`, `lib/blob-url-cache.ts`). Never set the `src` of an attachment to a file URL. Avatars, icons and banners stay plaintext.
- `cryptoStore` holds status, alerts and metadata only. It never holds key material, a recovery key or an invite seed.
- The voice UI shows call participants from the MLS tree (`components/voice/call-roster.ts`), not from the server roster.
- Pages: every page title, Yjs update, snapshot pointer and awareness frame is a page envelope (§12.20) from `encryptDoc`. `docsStore` holds the page tree and presence, never a `Y.Doc`. The `Y.Doc` stays in `DocProvider`. A page media node holds its pointer (with the file key) inside the `Y.Doc`, and shows through `use-decrypted-blob`.

## Working in the client library (`pkgs/hachiman-client`)

Browser-safe only (`fetch`, `WebSocket`, `RTCPeerConnection`): no Node imports, no rxjs, no protobuf. The wire contract lives in `docs/gateway-protocol.md` (§10 is the API of this package). There are no generated bindings.

- **Permissions**: each language defines them once. TS: `pkgs/hachiman-client/src/permissions.ts`. Go: `apps/hachiman-server/pkg/permissions/permissions.go`. `pkg/permissions/sync_test.go` parses the TS file and fails on any name/value mismatch. Change both together.
- **Adding a gateway event**: one change must include all of these:
  - the contract (§6, plus §4/§5 if REST publishes it)
  - `GatewayEvents` in `pkgs/hachiman-client/src/types.ts` (and the `HachimanClient` cache if the event mutates state)
  - the Takusen publish call (`apps/takusen/src/lib/events.ts` callers)
  - the gateway handling in `cmd/hachiman-gateway` (dispatch/visibility filtering)
  - for a device-scoped E2EE event (§12.13): `publishToDevice` in `apps/takusen/src/lib/events.ts`, and the `device:*` routing in the gateway
- Screen share: `VoiceConnection.setScreen(track, encoding)` swaps the track on the screen sender (m-line 1) with no renegotiation, and sets `selfStream` through op 4. No media frame carries the share state.
- E2EE: this package holds no crypto. `HachimanClient` takes a `device` callback (IDENTIFY facts) and a `voiceE2ee` delegate from the shared UI. Its cache holds ciphertext.

## Working in the crypto library (`pkgs/hachiman-crypto`)

Contract §12 of `docs/gateway-protocol.md` is normative for E2EE. `src/api.ts` (types and module interfaces) and `src/constants.ts` change together with §12, in the same change. `docs/e2ee-plan.md` gives the reasons. The package README has the module map.

- **No private key outside the crypto Worker.** All key material lives in the Worker (`src/worker/`). The UI thread gets only status, decrypted content and attachment pointers. Do not add a `CryptoApi` method that returns a key, except the recovery key and the invite seed (contract §12.17, below). Do not export engine modules from `src/index.ts`. The SFrame exporter secret of a call does not reach the UI thread either: the crypto Worker sends it to the transform Worker on a `MessagePort` that the UI thread does not read. The invite seed of an invite with history crosses the UI thread as opaque base64url text: `prepareHistoryInvite` returns it once, and `redeemInvite` takes it. The UI keeps it only in component state or an in-memory map and in the link fragment `#k=`. It never goes into a Zustand store or `localStorage`, and into `sessionStorage` only across the browser sign-in redirect.
- The Worker never calls `fetch`. It calls `DsTransport`, and the main thread does the REST call (`apps/hachiman/src/services/ds-transport.ts`).
- Only `src/worker/` imports `@hachiman/client` (`@hachiman/client/permissions`). `src/admin/` gets the permission rules through `AdminPermissionModel`.
- `src/mls/ds.ts` is the Node entry for Takusen. Its import graph uses only `globalThis.crypto`. It must not import `src/attachments`, `src/store`, `src/worker`, `src/bridge` or `src/media`.
- One device has one Worker. The bridge takes a Web Lock, so a second tab cannot open the same store.
- `src/smoke.spec.ts` pins the ts-mls behavior that the design needs. When you upgrade ts-mls, run it first.
- Security code fails closed: verify every signature, never reuse a nonce, and drop a frame or message that has no key.

## Working in the Go server (`apps/hachiman-server`)

Go module `hachiman/server`. Run from the package directory or through `pnpm dev:server` / `pnpm build:server`. Key areas:
- `cmd/hachiman-gateway/` — stateless WebSocket gateway: HELLO/IDENTIFY/RESUME (resume buffer `events:{sessionId}`), Redis event dispatch with VIEW_CHANNEL filtering, presence, voice join + placement + voice-token minting, TURN credentials. It calls Takusen REST only for `GET /users/@me` at IDENTIFY and Takusen gRPC only for `PlaceMediaSession`. It reads Postgres directly for READY, `media_nodes.signaling_url` and the `devices` row. E2EE (§12.13): IDENTIFY and RESUME carry a `deviceId`. The gateway closes with 4012 when IDENTIFY has no `e2ee/1` capability or `clientVersion` is too old. It closes with 4013 when the device is unknown or revoked. It delivers `device:{id}` events to the sessions of that device. The internal `DEVICE_REVOKED` event closes them with 4013. Pages (§6): client op 5 `DOC_AWARENESS` is relayed to `guild:{id}` after a view, type, size (8 KiB) and rate (20/s) check. `DOC_UPDATE` and `DOC_AWARENESS` are ephemeral: no `s`, not in the resume buffer. The WebSocket read limit is 64 KiB.
- `cmd/hachiman-media/` — stateless WebRTC SFU: voice WS (`/voice`), token verification + replay check, Takusen registration/heartbeat, Redis `media:{nodeId}` kicks. Each client has a mic track (Opus, stream id `<userId>`) and a screen track (VP8, stream id `screen-<userId>`). `e2ee.go` relays and orders the voice MLS group (§8, §12.10.1): roster, key packages, Welcomes, ratchet trees, first commit per epoch. It has no MLS library and signs nothing. The SFU forwards SFrame payloads unchanged.
- `cmd/hachiman-recorder/` — recording subscriber scaffold. Not wired: media serves no `RecorderControl`, and `pnpm build:server` does not build it.
- `pkg/media/` — SFU primitives (`sfu.go`, `ssrc_pool.go`). Only hachiman-media imports it.
- `pkg/voicetoken/` — PASETO voice token: `Signer` (gateway), `Verifier` (media)
- `pkg/permissions/` — Go half of the permission lib (+ `sync_test.go` against the TS file)
- `pkg/coturn/` — per-region TURN credential minting (HMAC-SHA1, coturn REST API scheme) for `iceServers`
- `pkg/management/` — Takusen management gRPC proto (`hachiman.management.v1`) + generated code. Regenerate with `go generate` in that directory. Never hand-edit `*.pb.go`.
- `pkg/takusenclient/` — wrapper around the Takusen `Management` gRPC (RegisterMediaNode / MediaNodeHeartbeat / PlaceMediaSession)
- `pkg/recorderproto/` — media↔recorder proto (scaffold)

Containerization: `Dockerfile.gateway`, `Dockerfile.media`, `Dockerfile.recorder` (amd64) and the `Dockerfile.arm32v6.*` variants. Each builds exactly one binary.

For changes to the voice stack (`pkg/media/sfu.go`, `pkg/media/ssrc_pool.go`, `cmd/hachiman-media/voice.go`, `pkgs/hachiman-client/src/voice.ts`), use the `webrtc-reviewer` agent. There is a class of SSRC pool / renegotiation race bugs that a generic review will miss. Also use it for SFrame and voice E2EE changes: `cmd/hachiman-media/e2ee.go`, `pkgs/hachiman-crypto/src/media/`, `apps/hachiman/src/services/voice-e2ee.ts`. Tell the agent to look for (key, CTR) reuse, a sender transform that the client makes again, and the order of roster and renegotiation. The file list in the agent definition predates the refactor (`pkg/web`, `cmd/grumble`, `hachiman-node`), so give the agent the paths above.

## Working in the Electron host (`apps/hachiman-electron`)

`src/main/`:

- `csp.ts` + `csp-policy.ts` — CSP built from the `VITE_` URLs. The browser host sends the same policy (`apps/hachiman-browser/csp.ts`).
- `secure-storage.ts` — the per-user wrap key for `IPlatformService.secureStorage`, sealed with Electron `safeStorage`. It fails closed without an OS keystore.
- `protocol-handler.ts` + `deep-link-route.ts` — deep links `takusen://invite/<code>[#k=<key>]` and `app.hachiman://oauth-callback`, single-instance lock
- `renderer-protocol.ts` + `renderer-path.ts` — packaged renderer on `hachiman://app/`
- `region-probe.ts` + `probe-target-guard.ts` — TCP RTT probe to each region's `probeHost`, with an SSRF guard
- `screen-share.ts` — desktopCapturer sources + display-media handler
- `tray.ts` + `app-prefs.ts` — the tray icon and close-to-tray (setting in `<userData>/app-prefs.json`, default on). The `before-quit` flag lets Cmd+Q, the tray "Quit" and an update install really quit
- `updater.ts` — auto-update from the newest release in `hachiman-release` through Takusen `GET /api/desktop-update/:platform` (contract §4 Desktop updates)

`src/preload/index.ts` exposes `window.hachiman`. Tests are `src/main/*.test.mts` (`node --test`).

## Working in Takusen (`apps/takusen`)

Two processes:
- The Next.js app (`pnpm dev`) — OIDC provider (`src/lib/oidc-provider.ts`, panva `oidc-provider`), next-auth dashboard sign-in, dashboard UI, REST API (`src/app/api/v1`), and the public `GET /api/regions` for the Electron region probe. Every REST mutation publishes its gateway event to Redis after the DB commit (`src/lib/events.ts`).
- Files: `POST /api/v1/uploads` streams the raw body to S3 (`src/lib/storage.ts`), and `GET /api/v1/files/:uploadId/:filename` streams it back with Range support. A message, avatar, icon or banner then claims the upload ids (`src/lib/uploads.ts`). Deletes go through `deleteAttachmentRows` so that objects do not leak. Clients never talk to S3. With E2EE, the bytes are opaque ciphertext blobs.
- Pages (contract §4 Pages, §12.20) live in `src/lib/docs/`: the page tree, the update log with a per-page `seq`, and the snapshot compare-and-set. The storage seam is `DocsRepo`, with a Drizzle and an in-memory implementation. Snapshot bytes and page media are encrypted S3 objects in `uploads` (purposes `page_snapshot` and `page_media`, column `page_id`). Postgres holds only the pointers. `guilds.page_storage_bytes` is the quota. `lib/page-media-sweep.ts` deletes unreferenced page media in the daily DS sweep. `lib/channel-types.ts` `TEXT_GROUP_TYPES` lists the types that use a text MLS group (`text`, `pages`).
- Invites with history (contract §12.11.4) live in `src/lib/invite-history.ts`: the record checks, the record list for members, and the sealed bundles (table `invite_bundles`, 4 MiB per invite, swept daily). The storage seam is `InviteHistoryStore`, with a Drizzle and an in-memory implementation. `invite-history.conformance.ts` runs on both, so change them together.
- The E2EE delivery service (DS, contract §12.7, §12.12, §12.18) lives in `src/lib/mls/`. It holds devices, key packages, MLS groups, handshakes, envelopes, the device inbox and key transparency (KT). The storage seam is `MlsRepo` (`lib/mls/repo.ts`), with a Drizzle and an in-memory implementation, as `MediaNodesRepo`. Other Takusen code calls only the exports that §12.18 lists. A route that changes membership calls `onMembershipChange` inside its transaction.
- A standalone gRPC server (`pnpm dev:grpc`) — implements the media-plane RPCs (`RegisterMediaNode`, `MediaNodeHeartbeat`, `PlaceMediaSession`) that hachiman-media and hachiman-gateway consume. It also runs the MLS batch scheduler, the KT tree-head timer and the daily DS sweeps. It is a separate process because Next has no clean "after listen" hook. A colocated gRPC port would flap on every dev file-watcher restart.

Both processes share the same Postgres DB through Drizzle. The proto source of truth is `apps/hachiman-server/pkg/management/management.proto`. The Takusen gRPC server loads it dynamically through `@grpc/proto-loader` (no generated TS bindings).

Storage seam: `apps/takusen/src/grpc/repo.ts` defines `MediaNodesRepo`. This is the narrow interface that every media-plane handler uses for DB access. Production wires Drizzle through `drizzleMediaNodesRepo`. Tests inject `InMemoryMediaNodesRepo` (`repo.in-memory.ts`), so the same handler code paths run without `DATABASE_URL`. When you add a new RPC that touches `media_nodes`, add a method to `MediaNodesRepo` and update BOTH implementations in lockstep. If you copy the SQL outside the repo (the old `placement-rank.ts` antipattern), the test and production paths drift silently.

Takusen gRPC security posture: the server binds **loopback by default** (`127.0.0.1`). The reason is that `RegisterMediaNode` / `MediaNodeHeartbeat` / `PlaceMediaSession` currently have NO application-layer auth. Operators who need an external bind set `TAKUSEN_GRPC_BIND_ADDR` explicitly. The server then logs a prominent warning at startup. mTLS lands with Phase 5 cert provisioning (paired with the Go-side follow-up #10 in `pkg/takusenclient/client.go`).

## Architecture references

The top-level `README.md` has mermaid diagrams for:

- component topology (incl. the crypto Worker and the transform Worker)
- connection + event flow (incl. encrypted uploads, device events, MLS events and RESUME)
- voice join with the E2EE ops + screen share
- the store/service/component layout of the shared UI

Each package README (`apps/*/README.md`, `pkgs/*/README.md`) has diagrams of where it fits, its code architecture and its key flows. Skim those before larger changes, and update them when a change moves a module or an interaction. They capture relationships that text does not.

## Stale tooling in `.claude/`

These files predate the Discord-style refactor and target the deleted Mumble/protobuf stack. Their removal is pending. Do not use them:

- skills `regen-proto` and `add-mumble-message`
- agent `proto-sync-checker`
- hooks `block-generated.sh` (guards `mumbleproto` paths, not `pkg/management` or `pkg/recorderproto`) and `format-edit.sh` (maps old package names)

## Don'ts

- Do not reintroduce `tsc` or a `typescript` devDependency anywhere. Use `tsgo`.
- Do not return fresh array/object literals from Zustand selectors.
- Do not edit `*.pb.go` by hand. Regenerate with `go generate`.
- Do not change a wire shape without an update to `docs/gateway-protocol.md` in the same change.
- Do not change `pkgs/hachiman-crypto/src/api.ts` or `constants.ts` without the matching update to contract §12.
- Do not let a private key or an MLS secret reach the UI thread. The crypto Worker sends only the SFrame exporter secret, and only to the transform Worker. The invite seed also crosses the UI thread, as the recovery key does (contract §12.17): opaque text in component state and the link fragment, never in a store or `localStorage`.
- Do not import `@hachiman/crypto` from `@hachiman/client`.
- Do not nest `TooltipProvider`s. There is already one at the App root.
- Do not add features beyond what the task requires. The UI is in active flux toward a Discord-like layout, and unrelated refactors create merge churn.
