# @hachiman/crypto

End-to-end encryption for Hachiman. The package holds every key and does every MLS, envelope, attachment and media-frame operation.

- The contract is `docs/gateway-protocol.md` §12. It is normative. The reasons are in `docs/e2ee-plan.md`.
- The typed API is `src/api.ts`. The constants are `src/constants.ts`. When you change one of them, change the contract in the same commit.
- The MLS library is [ts-mls](https://github.com/LukaJCB/ts-mls) 1.6.4 (MIT, pure TypeScript). No one has audited it. `src/smoke.spec.ts` pins the library behavior that the design uses.
- The other dependencies are `@noble/*` and `@hpke/*` (pure TypeScript on WebCrypto). There is no WebAssembly, so the hosts need no `'wasm-unsafe-eval'`.

## How it runs

```
UI thread                                  crypto Worker (src/worker/main.ts)    transform Worker (one per call)
──────────                                 ──────────────────────────────────    ───────────────────────────────
CryptoClient (src/bridge) ──RPC──────────▶ CryptoApi (src/worker/engine.ts)
DsTransport (apps/hachiman,                ◀── EngineContext.transport
  services/ds-transport.ts, RestClient)
                                           IdentityService  (src/identity)
                                           GroupService     (src/mls)
                                           MessageService   (src/envelope)
                                           AdminService     (src/admin)
                                           InviteService    (src/invites)
                                           VoiceService     (src/media) ──MessagePort──▶ FrameKeyRing (src/media/transform-worker.ts)
                                           CryptoStore      (src/store, IndexedDB)
```

- The bridge starts the Worker with `new Worker(new URL('../worker/main.ts', import.meta.url), { type: 'module' })`. `createTransformWorker` starts the transform Worker the same way. The hosts build both with Vite.
- The UI thread never holds private keys. It holds decrypted content and attachment pointers. Besides the recovery key, the invite seed of an invite with history crosses it, as opaque text (§12.17).
- The Worker never calls `fetch`. It calls `DsTransport`, and the main thread does the REST call with `@hachiman/client`.
- Every value that crosses a Worker boundary is structured-cloneable. Wire shapes use JS numbers, not `bigint`. The RPC transfers MessagePorts.
- One device has one Worker. The bridge takes the Web Lock `hachiman-crypto:{origin}:{userId}`, so a second tab does not open the same store. The second tab gets `LOCK_HELD_MESSAGE`.
- The transform Worker drops a frame that has no key. There is no plaintext passthrough.

Takusen (Node) imports `@hachiman/crypto/ds` (`src/mls/ds.ts`). It uses ts-mls to sign external proposals and to check commit uploads. It holds no group secrets. The import graph of `ds.ts` uses only `globalThis.crypto`. It does not import `src/attachments`, `src/store`, `src/worker`, `src/bridge` or `src/media`.

Dependency direction: this package depends on `@hachiman/client` (workspace dependency) for the §2 permission rules. Only `src/worker/permissions.ts` imports `@hachiman/client/permissions`. It gives the rules to `src/admin`, `src/mls` and `src/invites` as `AdminPermissionModel`. `@hachiman/client` never imports this package.

## Package exports

| Export | File | Use |
|---|---|---|
| `.` | `src/index.ts` | The UI thread: the types of `api.ts`, the constants, `fromB64url` / `toB64url`, `createCryptoClient`, `createTransformWorker`, `cryptoLockName`, `LOCK_HELD_MESSAGE`, `createCryptoStub`, `STUB_MARKER` |
| `./ds` | `src/mls/ds.ts` | Takusen: the `DsModule` (sign external proposals, check key packages, commits and GroupInfo, verify key objects, admin actions and invite records, parse invite records and envelope headers, verify franking openings) |
| `./constants` | `src/constants.ts` | Suites, labels, sizes, limits |
| `./codec` | `src/codec.ts` | The binary codec and base64url |

The package has no build step. Consumers import the TypeScript source.

## Module map

| Path | Contents | Contract |
|---|---|---|
| `src/api.ts` | All public types and the module interfaces | §12 |
| `src/constants.ts` | Suites, labels, sizes, limits | §12.3 |
| `src/codec.ts` | The binary codec (RFC 9420 presentation language), base64url, UUID bytes | §12.2 |
| `src/sign.ts` | Hachiman SignWithLabel (synchronous Ed25519) | §12.2 |
| `src/identity/` | Master key, device-signing key, device certificates, chain check, revocation (`index.ts`, `codec.ts`). Safety numbers and epoch codes (`safety.ts`). Device linking (`link.ts` steps, `link-engine.ts` flows). Device messages (`device-message.ts`, HPKE). Recovery key and backups (`recovery.ts`). `service.ts` implements `IdentityService` | §12.4, §12.5, §12.11.3 |
| `src/kt/` | RFC 6962 Merkle math and entry codecs (`index.ts`, client and Takusen). Tree-head pinning, inclusion checks, gossip (`client.ts`) | §12.14 |
| `src/admin/` | Signed admin actions: payload codecs, sign, verify, hash, chain replay (`index.ts`, `AdminActionModule`). `service.ts` implements `AdminService` | §12.16 |
| `src/invites/` | Invites with history: the record, bundle and auth codecs (`codec.ts`), the keys from the invite seed and the HPKE bundle seal (`keys.ts`), the record, bundle and auth signatures (`record.ts`). `codec.ts` and `record.ts` are pure, `ds.ts` uses them. `service.ts` implements `InviteService`: the record checks against the admin state, the bundles at creation and after each own commit (`GroupService.onOwnCommit`), the redemption (only the bundles of scope groups: by the group id, and by the descriptor of a group that it holds), the later fetches of the bundles after each join (`GroupService.onJoin`), `INVITE_DELETE` | §12.11.4, §12.16 |
| `src/mls/` | The ts-mls wrapper (`index.ts`, `MlsModule`). Shared framing, group id and chain pre-check (`wire.ts`). Proposal policy (`policy.ts`). History bundles (`history.ts`). `service.ts` implements `GroupService` (batches, joins, resync, inbox). `ds.ts` is the Node entry for Takusen | §12.6, §12.7, §12.11.2 |
| `src/envelope/` | Envelope seal and open, message keys, the sign-then-encrypt core that page envelopes share (`index.ts`), envelope codecs (`codec.ts`). `service.ts` implements `MessageService` (dedupe, edits, attachments). `doc.ts` seals and opens page envelopes, and `doc-service.ts` implements `DocService` (`encryptDoc`, `decryptDoc`) | §12.8, §12.20 |
| `src/attachments/` | STREAM AES-256-GCM in 64 KiB segments, Padmé, incremental SHA-256, thumbnails | §12.9 |
| `src/franking/` | Franking tag and report opening | §12.16 |
| `src/media/` | SFrame (`sframe.ts`), the frame transform logic (`transform.ts`), the `RTCRtpScriptTransform` Worker entry (`transform-worker.ts`). `service.ts` implements `VoiceService` (voice groups, committer role) | §8, §12.10 |
| `src/store/` | `CryptoStore` (`index.ts`): one IndexedDB database per (origin, user). A record is `0x01 ‖ nonce[12] ‖ AES-256-GCM` under the wrap key, with AAD = `encode(table<V> ‖ key<V>)`. Writes run one at a time. A transaction writes an overlay, then applies it in one IndexedDB transaction. `serialize.ts` is the deterministic record encoding (JSON with sorted keys, bytes as `{$b}`) | §12.17 |
| `src/worker/` | `main.ts` (Worker entry), `serve.ts` (serves the engine on an endpoint), `engine.ts` (composes the services, one queue per group), `rpc.ts` (typed RPC with method allowlists), `permissions.ts` (`AdminPermissionModel`) | §12.17 |
| `src/bridge/` | `index.ts`: `createCryptoClient` (main-thread proxy, Web Lock), `createTransformWorker`. `stub.ts`: `createCryptoStub` for the dev preview (NOT ENCRYPTED, marked with `STUB_MARKER`) | §12.17 |
| `src/index.ts` | Package exports | |

Test doubles, not exported: `src/bridge/test-harness.ts` (a Worker over an in-process `MessageChannel`, a Web Locks shim), `src/mls/fake-ds.ts` (an in-memory DS), `src/media/fake-media.ts` (the media relay rules without sockets), `src/envelope/fixtures.ts`, and the `test-helpers.ts` files.

## Commands

```bash
pnpm -F @hachiman/crypto test        # vitest (node environment, fake-indexeddb for the store)
pnpm -F @hachiman/crypto typecheck   # tsgo

# Inside the Claude sandbox (pnpm does not run there)
cd pkgs/hachiman-crypto && node_modules/.bin/vitest run
cd pkgs/hachiman-crypto && ../../node_modules/.bin/tsgo --noEmit -p tsconfig.json

# MLS load test (not part of the test run). Results: docs/e2ee-load-test.md
cd pkgs/hachiman-crypto && LOAD_SIZES=1000,2000 LOAD_ROUNDS=3 node_modules/.bin/vitest bench --run --execArgv=--expose-gc src/mls/load.bench.ts   # above 2048 leaves: see the file header
```

Use `tsgo`, never `tsc`.

## Security notes

- A leaked recovery key exposes all history.
- A leaked device store exposes the history of that device.
- Signed messages are non-repudiable. Every envelope carries a franking tag.
- The browser host trusts the server's code. The Electron host is the strong client.
- ts-mls has no partial trees. Every member holds the full ratchet tree. The smoke case "needs the full ratchet tree to join" fails when ts-mls adds support.
