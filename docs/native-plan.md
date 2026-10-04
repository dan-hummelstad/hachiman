# Native client plan (`hachiman-native`)

Status: draft for review. No code exists yet.

## 1. Goal

Add a native desktop client written in Rust:

- `pkgs/hachiman-native`: the Rust client library. It replaces `@hachiman/client` and `@hachiman/crypto` for the native app: REST, gateway, voice, E2EE and pages.
- `apps/hachiman-native`: the Rust desktop app. It uses GPUI for the UI and GPUI-Kit (https://gpui-kit.com) for the components.

The native client uses the same servers and the same wire contract (`docs/gateway-protocol.md`) as the Electron and browser hosts, without exceptions. A native user and an Electron user can be in the same encrypted channel, call and page.

## 2. Facts that shape the plan

| Fact | Effect |
|---|---|
| GPUI-Kit is Longbridge's toolkit (it was `gpui-component`). Crate `gpui-kit` 0.7 re-exports GPUI as `gpui-pre =0.3.7`, a snapshot of Zed's GPUI. Apache-2.0. | We depend only on `gpui-kit`, never on Zed's `gpui`. If we do, the build gets two incompatible GPUI copies. |
| GPUI has its own executors, not tokio. `gpui-pre` has no `gpui_tokio`. | The app vendors a small tokio bridge (about 50 lines, modeled on Zed's `gpui_tokio`). The library is plain tokio and has no GPUI dependency. |
| GPUI-Kit has `sidebar`, `virtual_list`, `input`/`textarea`, `dialog`, `popover`, `tooltip`, `menu`, `avatar`, `tab`, `message`, `message_scroller`, `title_bar`, `resizable`, `tree`, `notification` and theming. `TextView` renders Markdown. | Most of the shell is composition. Chat Markdown uses `TextView`. |
| GPUI-Kit has **no** WYSIWYG Markdown editor. Pages are Yjs `XmlFragment`s in the y-prosemirror (Milkdown) schema. | Page editing in native is a large custom job. See decision D3. |
| ts-mls writes `external_senders` as one `ExternalSender` with **no RFC 9420 vector prefix** (contract §12.6, `docs/e2ee-plan.md`). It is a group context extension, so it is also in the context hash. | An RFC-correct Rust MLS library (openmls, mls-rs) cannot read or make Hachiman text groups as they are now. See decision D1. This is the main risk. Phase 0 tests it first. |
| Handshakes are `PublicMessage`. The DS and the media node parse them. The full ratchet tree is always delivered out of band. | The Rust MLS library must allow plaintext handshakes and must not change leaf extensions in normal commits (ts-mls copies them). |
| SFrame (§12.10.2) uses a Hachiman-specific `base_key` (HKDF-Expand with `uint32(m)`, not RFC 9605's 8-byte sender id). The VP8 clear prefix is 10 bytes on a keyframe, else 1. | We cannot use the `sframe` crate's MLS key derivation as is. We write the derivation (small) and use the crate (or our own code) only for the AEAD frame. |
| webrtc-rs (`webrtc` 0.21, pure Rust) gives encoded-frame control but no codecs, capture or echo cancellation. LiveKit `libwebrtc` gives codecs and AEC, but its frame encryption is LiveKit's own scheme, not SFrame. | Use **webrtc-rs**. We own the encode path (cpal → Opus → SFrame → RTP), so we do not need a frame transformer. See decision D2. |
| OIDC client `hachiman-client` is public, uses PKCE S256, and is `application_type: native`. Takusen checks allowed origins only when an `Origin` header is present. | A native HTTP client sends no `Origin`. Sign-in uses an RFC 8252 loopback redirect. See decision D4. |
| Rust is not installed on this machine (`cargo` not found). | Prerequisite P1. |

## 3. Layout

One Cargo workspace at the repo root. pnpm ignores directories that have no `package.json`. The app gets a `package.json` only so that `pnpm -F` and the root scripts work, the same way as `hachiman-server`.

```
Cargo.toml                      [workspace] members = apps/hachiman-native, pkgs/hachiman-native
rust-toolchain.toml             stable, ≥ 1.91 (openmls MSRV), components rustfmt + clippy
.gitignore                      + /target

pkgs/hachiman-native/           crate `hachiman-native-core` (lib `hachiman_native_core`), no GPUI
  Cargo.toml
  README.md                     module map + mermaid diagrams, like the other package READMEs
  src/
    lib.rs
    types.rs                    §1 entities + gateway event payloads (serde, camelCase)
    permissions.rs              §2, port of pkgs/hachiman-client/src/permissions.ts
    auth.rs                     OIDC PKCE + loopback redirect, refresh (30 s skew, single flight), keyring
    rest.rs                     §4 + §12.12 routes; device proof headers; uploads with progress
    gateway.rs                  §6: HELLO/IDENTIFY/RESUME, heartbeat, close codes, ephemeral events
    client.rs                   HachimanClient: cache (ciphertext) + one event stream for the app
    e2ee/                       the crypto actor; see §5 "Key isolation"
      mod.rs                    CryptoHandle: the only public type of this module
      codec.rs                  §12.2 TLS presentation encodings, base64url, SignWithLabel
      identity.rs               §12.4 master key, DSK, device certificate, revocation, chain check
      proof.rs                  device proof (REST + IDENTIFY)
      mls.rs                    §12.6 groups, §12.7 committer/batch, resync, pending commit recovery
      envelope.rs               §12.8 message envelopes + franking
      page_envelope.rs          §12.20
      attachment.rs             §12.9 HAT1 streaming, Padmé
      sealed.rs                 §12.5 HPKE device messages, linking, SAS
      history.rs                §12.11 history keys, backups, recovery key (HRK1-)
      kt.rs                     §12.14 tree-head verification when the DS sets ktRequired
      store.rs                  local store: SQLite, each record AES-256-GCM under a keyring wrap key
    voice/
      mod.rs                    §8 media WS, E2EE voice group ops (§12.10.1)
      rtc.rs                    webrtc-rs peer connection (media offers, client answers)
      sframe.rs                 §12.10.2 key schedule + frame AEAD, replay window, epoch overlap
      audio.rs                  cpal capture/playback, Opus encode/decode, speaking detection
      screen.rs                 xcap capture, VP8 encode/decode (libvpx)
    docs/
      mod.rs                    DocsService: page tree, titles
      provider.rs               one yrs Doc + awareness per open page: load, batch, send, gap fill, snapshot
  tests/
    vectors/                    JSON vectors made by the TS crypto lib (see §6)

apps/hachiman-native/           crate `hachiman-native` (binary), package.json `@hachiman/hachiman-native`
  Cargo.toml
  package.json                  scripts: dev, build, test, lint, format (all cargo)
  README.md
  src/
    main.rs                     Application, window, tokio bridge, GPUI-Kit root + theme
    tokio_bridge.rs             vendored gpui_tokio equivalent
    state.rs                    GPUI entities that mirror the client cache (the Zustand stores' role)
    preview.rs                  `--preview`: fake data, no backend (the `?preview` role)
    views/
      shell.rs                  title bar, guild rail, channel sidebar, main pane, member list
      chat.rs                   message list (virtual), composer, attachments, typing, reactions as in the web UI
      voice.rs                  voice panel, call roster from the MLS tree, screen share view, call security
      pages.rs                  page tree + page view (see D3)
      settings.rs               account, devices, audio devices, theme
      security.rs               onboarding gate (CryptoGate role): new device, link, recovery, fatal screens
```

Root `package.json` gets `dev:native` and `build:native`. Crate names must differ inside one Cargo workspace, so the library is `hachiman-native-core` and the app is `hachiman-native`. Both directories are named `hachiman-native`, as requested.

Dependency direction: the app → `hachiman-native-core` → (tokio, reqwest, tokio-tungstenite, openmls or mls-rs, yrs, webrtc, cpal, opus, keyring, rusqlite). The library never depends on GPUI.

## 4. Crates

| Need | Crate | Note |
|---|---|---|
| UI | `gpui-kit = "0.7"` | Brings `gpui-pre =0.3.7`. Pin exactly. |
| Async | `tokio` (multi-thread) | Library runtime. |
| HTTP | `reqwest` (rustls) | Upload progress through a streaming body. |
| WebSocket | `tokio-tungstenite` (rustls) | Gateway and media WS. |
| OIDC | `oauth2` 5 | PKCE + code exchange. We do not need ID token validation beyond what `/users/@me` gives. |
| Keychain | `keyring` 4 | Wrap key and refresh token. Fail closed when no OS keystore exists (same rule as Electron). |
| Local store | `rusqlite` (bundled) | One DB per (Takusen origin, user). |
| MLS | `openmls` 0.9 (default) or `mls-rs` | Phase 0 decides. Both have suite 1. |
| Crypto primitives | RustCrypto: `ed25519-dalek`, `x25519-dalek`, `aes-gcm`, `hkdf`, `hmac`, `sha2`, `hpke` | Same primitives as the TS lib. |
| CRDT | `yrs` 0.28 | Yjs v1 updates are binary compatible. |
| WebRTC | `webrtc` 0.21 | |
| Audio | `cpal` 0.18, `opus` 0.4 | |
| Screen | `xcap`, `vpx`-family bindings (libvpx) | Needs libvpx on the build machine. |

## 5. Design rules

- **Key isolation.** All key material lives in the `e2ee` actor: one dedicated thread that owns the MLS state, the identity keys and the store. Other code talks to it through `CryptoHandle` (channels), the same as the TS Worker boundary. No public function returns a private key. The only secret that leaves the actor is the SFrame epoch secret, and it goes only to `voice::sframe`. Native code runs in one address space, so this is a code boundary, not an OS boundary. It is still stronger than the browser host, because the code ships with the app. `hostTrust` for native is the same as Electron.
- **Decrypt before state.** `client.rs` keeps ciphertext. The app state (`state.rs`) gets only decrypted content from the actor. The app never renders an envelope as text.
- **Fail closed.** Verify every signature. Never reuse a nonce. Drop a frame or message that has no key.
- **One device, one process.** Take an OS file lock on the store. A second app instance shows "open in another window", like `LockHeld`.
- **State in the UI.** The client sends events on one channel. The app reads it on the GPUI foreground and updates entities, then calls `cx.notify()`. Views read entities; they do not call the network directly.
- **No contract drift.** Every wire change goes into `docs/gateway-protocol.md` in the same change.

## 6. Interop testing

The native code must produce and accept the same bytes as `@hachiman/crypto`. Plan:

1. A script `pkgs/hachiman-crypto/scripts/native-vectors.ts` (tsx) uses the TS lib to make JSON vectors: TLS encodings, SignWithLabel, device certificates and chains, device proofs, envelopes (encrypt with fixed keys), page envelopes, HAT1 attachments, recovery keys, sealed device messages, SFrame keys and frames, and MLS groups (a Hachiman group with the DS external sender, a Welcome, a commit, an exporter output).
2. The vectors are committed in `pkgs/hachiman-native/tests/vectors/`. `cargo test` reads them in both directions: Rust decrypts or verifies TS output, and Rust output matches TS output where it is deterministic.
3. `permissions.rs` gets a sync test that parses `pkgs/hachiman-client/src/permissions.ts`, like `pkg/permissions/sync_test.go`.
4. The final phase runs a live check: a native client and the browser host in the same text channel, voice call and page against `pnpm dev:server` + `pnpm dev:takusen`.

## 7. Decisions for your review

I have picked a default for each. Change any of them before the workers start.

- **D1. The `external_senders` encoding.** The options are:
  - (a) **Default:** fix the TS side to the RFC encoding. Extend `patches/ts-mls@1.6.4.patch` so that ts-mls writes and reads the RFC 9420 vector form. Update §12.6. Run `pnpm db:reset` (dev stage: we drop data instead of migrating). Takusen's DS uses the same ts-mls, so it changes in the same patch.
  - (b) Fork openmls (or mls-rs) to read and write the ts-mls form. This keeps the TS side as it is, but we then maintain a nonstandard MLS fork in two languages.

  Phase 0 confirms the problem with a real cross-test before we change anything.
- **D2. WebRTC stack.** Default: webrtc-rs. It has no echo cancellation, so the first version needs headphones or push-to-talk. The follow-up is the `webrtc-audio-processing` crate (AEC/AGC/NS). The alternative is LiveKit `libwebrtc`: it has AEC and codecs, but we would have to add a SFrame frame transformer to its C++ layer.
- **D3. Page editing.** Default for this pass: the native app shows the page tree, makes, renames, moves and deletes pages, and renders page content read only (yrs `XmlFragment` → Markdown → `TextView`). It joins awareness so that other users see the native user as a viewer. It decrypts snapshots and live updates. It does not edit page bodies. A WYSIWYG editor over yrs in the y-prosemirror schema is a separate project after this plan.
- **D4. Sign-in redirect.** Default: RFC 8252 loopback, `http://127.0.0.1:<random port>/oauth/callback`. The app runs a one-shot local listener and opens the system browser. Takusen's seed adds the loopback URI. Phase 1 checks that panva `oidc-provider` accepts any port for a native client's loopback URI. The alternative is to reuse `app.hachiman://oauth-callback`, but then the Electron app and the native app fight over one OS scheme.
- **D5. Invite deep links.** Default: none in this pass. The native app has a "Join with invite code" dialog. `takusen://invite/<code>` stays with Electron.
- **D6. Screen share.** Default: view and send. If the libvpx build blocks a platform, viewing ships first and sending follows.
- **D7. Admin features.** Default: the native app does not do signed admin actions (§12.16) in this pass. It can read guild settings but cannot change roles or permissions. Electron stays the admin client.

## 8. Phases and workers

Ten Opus workers, at most. Each worker has a tight scope and exact paths, and runs in its own worktree branch off one integration branch `native`. I merge each worker's branch into `native` and resolve conflicts. Workers only add files under their paths plus the shared files that their row names.

### Phase 0: prove the risks (2 workers, parallel)

| # | Worker | Scope | Done when |
|---|---|---|---|
| W1 | MLS interop spike | `pkgs/hachiman-crypto/scripts/native-vectors.ts` (MLS part), `pkgs/hachiman-native/src/e2ee/mls.rs` (first cut), `pkgs/hachiman-native/tests/mls_interop.rs` | A Rust member joins a ts-mls group with the Hachiman extensions (0xF1A0, 0xF1A1, external_senders), processes a ts-mls commit, makes a commit that ts-mls accepts, and gets the same exporter output. Report: which library, and the D1 result. If D1 (a) is chosen, it includes the ts-mls patch + §12.6 change + a passing `pnpm -F @hachiman/crypto test`. |
| W2 | Scaffold | root `Cargo.toml`, `rust-toolchain.toml`, `.gitignore`, both crates' `Cargo.toml`, `main.rs`, `tokio_bridge.rs`, `apps/hachiman-native/package.json`, root scripts, both READMEs (first cut) | `cargo build` and `cargo test --workspace` pass. `pnpm dev:native` opens a GPUI-Kit window with the theme and an empty shell. |

Gate: W1 says that a Rust MLS library can join, commit and export with ts-mls. If not, I stop and report before Phase 1.

### Phase 1: the library and the shell (5 workers, parallel)

| # | Worker | Scope | Done when |
|---|---|---|---|
| W3 | REST + auth + types | `types.rs`, `permissions.rs`, `auth.rs`, `rest.rs`; Takusen seed loopback redirect (D4) | Sign-in against dev Takusen works from a test binary. The permissions sync test passes. Every §4 and §12.12 route that the native UI uses has a method. |
| W4 | Gateway + client cache | `gateway.rs`, `client.rs` | IDENTIFY with a device proof, heartbeat, RESUME after a dropped socket, 4012/4013 handling, cache updates for every §6 event. Tests with a local fake gateway. |
| W5 | E2EE primitives | `e2ee/codec.rs`, `identity.rs`, `proof.rs`, `envelope.rs`, `page_envelope.rs`, `attachment.rs`, `sealed.rs`, `history.rs`, `store.rs`, vector generator (non-MLS part) | All non-MLS vectors pass in both directions. The store survives a restart and fails closed without a keychain. |
| W6 | E2EE groups + actor | `e2ee/mod.rs`, `e2ee/mls.rs` (full), `e2ee/kt.rs` | The `CryptoHandle` API: device registration, key packages, group join/create, committer and batch rules (§12.7), handshake processing, resync, encrypt/decrypt message and page envelopes. Tests against the in-memory DS from Takusen's test suite, or recorded DS responses. |
| W7 | UI shell on preview data | `apps/hachiman-native/src/state.rs`, `preview.rs`, `views/shell.rs`, `views/chat.rs`, `views/settings.rs` | `pnpm dev:native -- --preview` shows the guild rail, channels, a virtual message list with Markdown, the composer, the member list and settings, all from fake data, in light and dark themes. It follows `docs/ui-redesign.md` where GPUI-Kit allows. |

W6 depends on W5's `codec.rs`. W5 delivers `codec.rs` first, and W6 starts on top of it.

### Phase 2: features and wiring (3 workers, parallel)

| # | Worker | Scope | Done when |
|---|---|---|---|
| W8 | Voice + screen share | `voice/*`, `views/voice.rs` | A native user and a browser user hear each other in an E2EE call. The roster comes from the MLS tree. Mute, deafen and speaking work. Screen share views (and sends, D6). The `webrtc-reviewer` agent reviews it with the §12.10 paths and the (key, CTR) reuse checklist from CLAUDE.md. |
| W9 | Pages | `docs/*`, `views/pages.rs` | D3 scope: tree, titles, read-only live content, awareness as viewer, snapshot decrypt. |
| W10 | Integration + onboarding | `views/security.rs`, wiring of `state.rs` to `HachimanClient` + `CryptoHandle`, attachments (upload, decrypt, show), contract and README updates | The live check in §6 step 4 passes for text and attachments. A new native device can be set up by recovery key or linked from an Electron device (SAS). `docs/gateway-protocol.md` §11 and §12.17 describe the native host. Root `README.md` and `CLAUDE.md` list the new packages and commands. |

### Final review

After the merge, I run the project's review skills (remove-dumb-comments and the thermo-nuclear code quality review), plus `cargo clippy -D warnings`, `cargo test --workspace`, and the TS test suites that Phase 0 touched. I then open a draft PR from `native`.

## 9. Prerequisites

- **P1. Rust toolchain.** Run `! curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh` (or `brew install rustup`), then `rustup default stable`. Xcode command-line tools for Metal.
- **P2. libvpx and opus.** `brew install libvpx opus pkg-config` (D6, audio).
- **P3. Sandbox network.** Workers need `crates.io`, `static.crates.io` and `index.crates.io` to build. They also need the dev stack (`pnpm dev:server`, `pnpm dev:takusen`, Docker) for W3, W8 and W10 live checks.

## 10. Not in this pass

Page body editing (D3), echo cancellation (D2), invite deep links (D5), signed admin actions (D7), X-Wing suite 83 (§12.15), packaging, signing and auto-update, Linux and Windows checks (the code stays portable, but only macOS gets tested).
