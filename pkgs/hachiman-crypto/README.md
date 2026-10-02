# @hachiman/crypto

End-to-end encryption for Hachiman. The package holds every key and does every MLS, envelope, attachment and media-frame operation.

- The contract is `docs/gateway-protocol.md` §12. The reasons are in `docs/e2ee-plan.md`.
- The typed API is `src/api.ts`. The constants are `src/constants.ts`. When you change one of them, change the contract in the same commit.
- The MLS library is [ts-mls](https://github.com/LukaJCB/ts-mls) 1.6.4 (MIT, pure TypeScript). No one has audited it. `src/smoke.spec.ts` pins the library behavior that the design uses.

## How it runs

```
UI thread                                  crypto Worker                         transform Worker (one per call)
──────────                                 ─────────────                         ───────────────────────────────
CryptoClient (src/bridge) ──RPC──────────▶ CryptoApi (src/worker)
DsTransport (ui-core, over RestClient) ◀── EngineContext.transport
                                           IdentityService  (src/identity)
                                           GroupService     (src/mls)
                                           MessageService   (src/envelope)
                                           VoiceService     (src/media) ──MessagePort──▶ SFrame (src/media/transform-worker.ts)
                                           CryptoStore      (src/store, IndexedDB)
```

- The UI thread never holds private keys. It holds decrypted content and attachment pointers.
- The Worker never calls `fetch`. It calls `DsTransport`, and the main thread does the REST call with `@hachiman/client`.
- Every value that crosses a Worker boundary is structured-cloneable. Wire shapes use JS numbers, not `bigint`.
- One device has one Worker. The bridge takes a Web Lock, so a second tab does not open the same store.

Takusen (Node) imports `@hachiman/crypto/ds` (`src/mls/ds.ts`). It uses ts-mls to sign external proposals and to check commit uploads. It holds no group secrets. The import graph of `ds.ts` uses only `globalThis.crypto`. It does not import `src/attachments`, `src/store`, `src/worker`, `src/bridge` or `src/media`.

The admin chain replay uses the permission rules of `@hachiman/client/permissions` (workspace dependency). `@hachiman/client` never imports this package.

## Module map

| Path | Contents | Contract |
|---|---|---|
| `src/api.ts` | All public types and the module interfaces | §12 |
| `src/constants.ts` | Suites, labels, sizes, limits | §12.3 |
| `src/codec.ts` | The binary codec (RFC 9420 presentation language), base64url, UUID bytes | §12.2 |
| `src/sign.ts` | Hachiman SignWithLabel (synchronous Ed25519) | §12.2 |
| `src/identity/` | Master key, device-signing key, device certificates, chain check, revocation, safety numbers, epoch codes, device linking, device messages, recovery key, backups. `service.ts` implements `IdentityService` | §12.4, §12.5, §12.11.3 |
| `src/kt/` | RFC 6962 Merkle math (client and Takusen), tree-head checks, self-monitoring | §12.14 |
| `src/admin/` | Signed admin actions: payload codecs, sign, verify, hash, chain replay (`AdminActionModule`). `service.ts` implements `AdminService` (Phase 4) | §12.16 |
| `src/mls/` | The ts-mls wrapper (`MlsModule`), the authentication service, proposal policy, batch commits, joins, resync, history bundles. `service.ts` implements `GroupService`. `ds.ts` is the Node entry for Takusen | §12.6, §12.7, §12.11.2 |
| `src/envelope/` | Envelope seal and open, message keys, dedupe, edits. `service.ts` implements `MessageService` | §12.8 |
| `src/attachments/` | STREAM AES-256-GCM, Padmé, thumbnails | §12.9 |
| `src/franking/` | Franking tag and report opening | §12.16 |
| `src/media/` | SFrame, KID packing, voice groups (`service.ts` implements `VoiceService`), `transform-worker.ts` for `RTCRtpScriptTransform` | §12.10 |
| `src/store/` | `CryptoStore`: IndexedDB records sealed under the wrap key. AAD = `encode(table<V> ‖ key<V>)` | §12.17 |
| `src/worker/` | The Worker entry: composes the services and serves `CryptoApi` over RPC | §12.17 |
| `src/bridge/` | `createCryptoClient` (main-thread proxy), `createCryptoStub` (dev preview) | §12.17 |
| `src/index.ts` | Package exports | |

## Commands

```bash
pnpm -F @hachiman/crypto test        # vitest (node environment, fake-indexeddb for the store)
pnpm -F @hachiman/crypto typecheck   # tsgo

# Inside the Claude sandbox (pnpm does not run there)
cd pkgs/hachiman-crypto && node_modules/.bin/vitest run
cd pkgs/hachiman-crypto && ../../node_modules/.bin/tsgo --noEmit -p tsconfig.json
```

Use `tsgo`, never `tsc`.

## Security notes

- A leaked recovery key exposes all history.
- A leaked device store exposes the history of that device.
- Signed messages are non-repudiable. Every envelope carries a franking tag.
- The browser host trusts the server's code. The Electron host is the strong client.
