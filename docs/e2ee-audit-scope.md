# End-to-end encryption: audit scope

This document prepares the external audit of Phase 4 (`docs/e2ee-plan.md`, "Phases"). It does not replace the audit. We cannot audit our own code, so an external team must do it.

The normative contract is `docs/gateway-protocol.md` §12. The crypto interfaces are in `pkgs/hachiman-crypto/src/api.ts`. Section numbers like "§12.8.2" refer to the contract.

## 1. Scope

**In scope:**
- `pkgs/hachiman-crypto`: identity, MLS integration, message envelopes, attachments, SFrame, history keys, backups, key transparency (KT), signed admin actions, franking, the encrypted store and the Worker.
- The delivery service (DS) rules in Takusen: `apps/takusen/src/lib/mls/`, the §12.12 routes, admin action checks and the report route.
- The voice E2EE relay in the media node: `apps/hachiman-server/cmd/hachiman-media/e2ee*.go` and the identify step of `voice.go`.
- The device checks in the gateway (IDENTIFY, RESUME, `device:{id}` delivery) and the voice token.
- The key storage seam of the hosts: `IPlatformService.secureStorage` in Electron and in the browser, and the CSP.
- The use of ts-mls 1.6.4 by Hachiman. The audit of ts-mls itself is a separate item (section 8, L-1).

**Out of scope:**
- A compromised device (plan, "Threat model").
- Denial of service by the server: it can drop, delay or refuse messages and calls.
- Metadata: who talks to whom, when, sizes, IP addresses, voice presence.
- The shared React UI, except where it shows security state (safety numbers, "membership at that time not verified", host trust label, KT and fork alerts).
- OIDC, sessions, and the non-E2EE REST routes.

## 2. Threat model summary

The attacker is the operator, a compromised server, or an attacker with access to Postgres, S3, Redis or the network. This attacker must not read, forge or replay content. Content is message text, attachments, and voice, video and screen-share frames.

The server can still:
- See metadata.
- Refuse service.
- Make its own accounts and give them roles. In a public channel this lets it join, because anyone can join. In DMs and private channels, only a member device can add a device, and the UI shows who added whom. Signed admin actions (§12.16) make the role data that clients use for Adds verifiable.

Trust levels:
- **Electron host:** the strong client. It loads code from the app bundle.
- **Browser host:** it "trusts the server's code", because a hostile server can send hostile JavaScript. `CryptoStatus.hostTrust` reports this.
- **Media node:** it signs nothing and proposes nothing. It orders voice commits and keeps the voice roster. A hostile media node can claim that a participant left, or hide that a participant left (plan, Implementation note 2).
- **Takusen (DS):** it signs external Remove proposals, and Add proposals only for `public_set` groups. It never commits. It checks every commit without group secrets.

## 3. Security-critical files

Line counts are from 2026-10-02 on branch `e2ee`. Test files are not in the counts.

### 3.1 `pkgs/hachiman-crypto/src` (about 14,300 lines with helpers)

| File | Lines | What to examine |
|---|---|---|
| `codec.ts` | 294 | The one binary codec (§12.2): varints, `opaque<V>`, `optional`, strict base64url, UUIDs |
| `constants.ts` | 211 | Labels, HKDF info strings, sizes, limits |
| `sign.ts` | 32 | `SignWithLabel` / `VerifyWithLabel` |
| `api.ts` | 1759 | All interfaces and error codes |
| `identity/codec.ts` | 480 | Master key, DSK, device certificate, revocation, link, backup codecs |
| `identity/index.ts` | 254 | Chain checks, revocation checks |
| `identity/service.ts` | 1147 | TOFU pinning, DSK rotation, revocation, recovery, KT use |
| `identity/link-engine.ts` | 418 | Device linking by QR and SAS (§12.5) |
| `identity/link.ts` | 139 | Link key derivation, SAS |
| `identity/recovery.ts` | 116 | Recovery key text form, `K_backup`, `key_id` |
| `identity/device-message.ts` | 92 | HPKE device messages |
| `identity/safety.ts` | 56 | Safety numbers |
| `mls/index.ts` | 639 | ts-mls wrapper: create, commit, join, exporter |
| `mls/service.ts` | 1157 | GroupService: handshakes, pending Removes, batches, fork alert |
| `mls/policy.ts` | 209 | The §12.7.3 policy table on the client |
| `mls/wire.ts` | 450 | MLS framing, group ids, leaf chains, context extensions |
| `mls/ds.ts` | 509 | `DsModule`: `checkCommit`, inspectors, verifiers (runs in Takusen) |
| `mls/history.ts` | 110 | History bundles (§12.11.2) |
| `envelope/codec.ts` | 440 | Envelope, content and plaintext codecs and limits |
| `envelope/index.ts` | 174 | `K_msg`, seal, open |
| `envelope/service.ts` | 330 | The §12.8.5 receive steps, dedupe, rollback |
| `attachments/index.ts` | 197 | Chunked AEAD, Padmé (§12.9) |
| `media/sframe.ts` | 216 | SFrame header, key schedule, frame AEAD |
| `media/transform.ts` | 238 | Key ring, CTR, replay window, epoch retention |
| `media/service.ts` | 542 | Voice group logic on the client |
| `media/transform-worker.ts` | 79 | `RTCRtpScriptTransform` adapter |
| `kt/index.ts` | 183 | KT codecs, RFC 6962 / RFC 9162 Merkle math |
| `kt/client.ts` | 205 | Tree-head pinning, consistency, inclusion, gossip |
| `admin/index.ts` | 348 | Admin action codecs, sign, verify, hash, replay |
| `invites/codec.ts`, `invites/keys.ts`, `invites/record.ts` | 417 | Invites with history (§12.11.4): record, bundle and auth codecs, the keys from the seed, the HPKE bundle seal, the signatures |
| `invites/service.ts` | 553 | The record checks against the admin state (§12.16), the scope from the own descriptors and the group ids, bundles after own commits, redemption and its key limits, the later fetches after a join, the seed wipe |
| `franking/index.ts` | 71 | Franking tag, constant-time compare |
| `store/index.ts` | 353 | Encrypted IndexedDB store, AAD |
| `store/serialize.ts` | 79 | Store record encoding |
| `worker/engine.ts` | 235 | Worker entry, service wiring |
| `worker/rpc.ts` | 301 | Worker RPC, error mapping |
| `worker/permissions.ts` | 44 | Which calls the UI may make |
| `bridge/index.ts` | 144 | UI-side bridge, Web Lock (one tab per device) |

### 3.2 Takusen (`apps/takusen/src`)

| File | Lines | What to examine |
|---|---|---|
| `lib/mls/commits.ts` | 328 | §12.7.3 checks 1 to 11 around `checkCommit` |
| `lib/mls/batches.ts` | 280 | Batch scheduler (§12.7.5) |
| `lib/mls/membership.ts` | 305 | Remove proposals on permission changes |
| `lib/mls/readers.ts` | 100 | `channelReaders` |
| `lib/mls/groups.ts` | 274 | Group creation (§12.7.7) |
| `lib/mls/envelopes.ts` | 98 | §12.8.4 server checks |
| `lib/mls/identity.ts` | 327 | Key uploads, revocation, KT appends |
| `lib/mls/kt.ts` | 128 | KT heads and proofs |
| `lib/mls/key-packages.ts` | 81 | Key package checks and claims |
| `lib/mls/joins.ts` | 98 | Join requests |
| `lib/mls/proposals.ts` | 53 | External proposal signing |
| `lib/mls/device-data.ts` | 248 | Inbox, backups, history bundles, link sessions |
| `lib/mls/device-auth.ts` | 45 | `X-Hachiman-Device` check |
| `lib/mls/wire-format.ts` | 187 | The binary framings that the DS reads itself |
| `lib/mls/bytes.ts` | 134 | Strict base64url, the RFC 9420 reader |
| `lib/mls/keys.ts` | 67 | DS and KT seed loading |
| `lib/mls/route.ts` | 92 | Route wrapper, body parsing |
| `lib/mls/repo.drizzle.ts` | 678 | SQL, compare-and-set on `(group_id, epoch)` |
| `lib/admin-actions.ts` | 256 | `X-Hachiman-Signed-Action` checks |
| `app/api/v1/reports/report.ts` | 61 | Franking report check |
| `lib/wire.ts` | 320 | Message body schemas |
| `app/api/v1/{mls,devices,kt,backups,reports,users}/**/route.ts` | 887 (all) | Route bodies and limits |

### 3.3 Go server (`apps/hachiman-server`)

| File | Lines | What to examine |
|---|---|---|
| `cmd/hachiman-media/e2ee.go` | 845 | Voice room state machine: ordering, transitions, failover, evictions |
| `cmd/hachiman-media/e2ee_wire.go` | 106 | Commit header parse, strict base64url |
| `cmd/hachiman-media/voice.go` | 519 | Identify: E2EE check, token, device claim |
| `pkg/voicetoken/*.go` | 387 | PASETO v4 voice token, replay cache |
| `cmd/hachiman-gateway/session.go` | 551 | IDENTIFY and RESUME device checks |
| `cmd/hachiman-gateway/semver.go` | 123 | Minimum client version |

### 3.4 UI and hosts

| File | Lines | What to examine |
|---|---|---|
| `apps/hachiman/src/services/CryptoService.ts` | 295 | Worker start, wrap key, fatal states |
| `apps/hachiman/src/services/message-decrypt.ts` | 226 | Decrypt results shown to the user |
| `apps/hachiman/src/services/voice-e2ee.ts` | 131 | Voice E2EE wiring |
| `apps/hachiman/src/services/AdminActionService.ts` | 216 | Signing of admin actions |
| `apps/hachiman-electron/src/main/secure-storage.ts` | 259 | `safeStorage` wrap key, Linux backend refusal |
| `apps/hachiman-electron/src/main/csp-policy.ts` | 64 | CSP rules |
| `apps/hachiman-browser/src/platforms/browser/secure-storage.ts` | 180 | Non-extractable IndexedDB wrap key |

## 4. Invariants to check

Each invariant has an ID, so that an auditor can refer to it. "Tested by" names the test that checks it today.

### 4.1 Nonce and key uniqueness

- **N-1 Envelope.** `K_msg` is unique per message: HKDF of `S_e` with a random 32-byte `salt` and `sender_leaf` (§12.8.2). The nonce is 12 zero bytes. Examine that `salt` comes from a CSPRNG on each seal, also on a retry after 409 `StaleEpoch`. Tested by `envelope.spec.ts` ("fresh salt and franking key per seal").
- **N-2 Attachments.** `key` is 32 random bytes per file, and `nonce_prefix` is 7 random bytes. `nonce_i = prefix ‖ uint32(i) ‖ last`. Examine that a thumbnail gets its own key. Tested by `attachments.spec.ts`.
- **N-3 SFrame.** (key, CTR) never repeats. CTR is per KID on the key entry. A key entry is replaced only by a different secret. Tested by `media/transform.fuzz.spec.ts` ("never reuses (key, KID, CTR)").
- **N-4 SFrame after retire.** `FrameKeyRing` forgets the counters of a retired epoch. If the crypto Worker sends the same epoch secret again after `retire`, CTR starts again at 0 under the same key. Examine that `media/service.ts` never does this. Today it retires only on a room reset, and the new group has new secrets.
- **N-5 Sender transform.** One sender transform per (call, track). A new transform needs a new epoch first (§12.10.2).
- **N-6 Store.** Each record uses AES-256-GCM with a random 12-byte nonce under the wrap key. The AAD `encode(struct { table<V>; key<V> })` is injective (§12.17).
- **N-7 Backups and history bundles.** `BackupBlob.nonce` and `HistoryBundle.nonce` are random per blob. `K_backup` is the same for all blobs of one recovery key, so nonce collisions must stay negligible (12 random bytes, at most 256 MiB per user).

### 4.2 AAD bindings

- **A-1** Envelope AAD = `encode(header)`. Thus group, channel, epoch, sender leaf, sender device, `client_msg_id`, salt and franking tag are bound. Tested by `envelope.spec.ts` ("gives aead when any header field changes").
- **A-2** Attachment AAD = the 13-byte blob header. The `last` byte of the nonce stops truncation and reorder.
- **A-3** SFrame AAD = SFrame header ‖ clear prefix. Tested by `sframe.spec.ts`.
- **A-4** History bundle AAD = all fields before `ciphertext`. Backup AAD = version ‖ kind ‖ `key_id`.
- **A-5** Device message AAD = `sender_device_id` (§12.5). Link transfer AAD = the transcript hash `th`.

### 4.3 Signature coverage

- **S-1** Every Hachiman signature uses `SignWithLabel` with a distinct label (§12.2). Examine that no two objects share a label and that the label prefix is `"Hachiman 1.0 "`.
- **S-2** The envelope signature covers SHA-256(header) ‖ SHA-256(content). The receiver uses the sender device certificate, not the leaf of that epoch (plan, note 4).
- **S-3** An admin action signature covers every field before `signature`. Tested by `admin.fuzz.spec.ts` ("a flipped action never verifies").
- **S-4** A tree head signature covers `TreeHeadTBS`. Tested by `kt.fuzz.spec.ts`.
- **S-5** The voice token (PASETO v4 public) covers every claim. Tested by `FuzzVerify` in `pkg/voicetoken`.
- **S-6** A PublicMessage commit signature does not cover `confirmation_tag` and `membership_tag` (RFC 9420). The DS cannot check them (section 8, L-4). Tested by `ds.fuzz.spec.ts`.

### 4.4 Chain checks

- **C-1** A client rejects every leaf without a valid master → DSK → device certificate chain (§12.4). This blocks ghost devices.
- **C-2** A pinned master key changes only with a signature by the previous master key (`prev_signature`), or after a visible reset.
- **C-3** A revoked device is accepted only while a Remove for its leaf is queued (§12.4 rule 7, §12.7.3 check 8).
- **C-4** `checkCommit` examines new and changed leaves only. Unchanged leaves are not checked again. Examine that "unchanged" means byte-equal leaf nodes (`sameLeafBytes`).
- **C-5** `deviceCertificate()` returns certificates of revoked devices for history, but only under a DSK generation that the client saw in this session (open issue of `crypto-identity`).

### 4.5 DS commit rules (§12.7.3)

- **D-1** Exactly one commit wins per `(group_id, epoch)`: the compare-and-set in check 10. Tested by `commits.test.ts` on the in-memory repo.
- **D-2** The roster transition of check 5 equals the uploaded tree. Thus a tree cannot hide an Add. Examine the inference for proposals by reference: `checkCommit` sees only refs and counts one removed leaf or one new leaf per unknown ref (open issue of `crypto-mls`).
- **D-3** A proposal by reference must be a DS proposal that Takusen published for this epoch (check 6).
- **D-4** The next roster passes `channelReaders` and the §12.7.3 policy table (check 9).
- **D-5** The DS never commits and never holds group secrets.
- **D-6** The DS signs exactly one external proposal per pending item and epoch (§12.7.4).

### 4.6 Batch scheduler (§12.7.5)

- **B-1** The committer is the online member device with the lowest leaf index, without Remove targets and without devices in the 60 s cooldown.
- **B-2** A timeout or a decline moves the batch to the next device. A second decline gives 410.
- **B-3** A client that holds an unapplied Remove proposal commits it before it encrypts (§12.7.4). Examine `GroupService.sendState`.
- **B-4** With no member online, a `public_set` joiner uses an external commit. Other kinds wait.

### 4.7 Key transparency (§12.14)

- **K-1** Inclusion and consistency proofs follow RFC 9162 §2.1.3.2 and §2.1.4.2. Tested by `kt.spec.ts` (all sizes up to 64) and `kt.fuzz.spec.ts`.
- **K-2** `verifyInclusion` does not bind the tree size by itself. A proof for leaf 0 of size 5 also passes with `treeSize` 6 against the size-5 root. The caller must take `treeSize` and the root from one verified `SignedTreeHead`. `kt/client.ts` does this. Examine every caller.
- **K-3** A client trusts a fetched key object only after an inclusion proof against a head at least as new as its stored head.
- **K-4** Two heads of one size with different roots, or a failed consistency proof, raise `ktAlert` `split_view`.
- **K-5** Takusen appends KT entries under `pg_advisory_xact_lock`, so the log has no gaps.
- **K-6** Before the first stored head, a client skips proofs (Phase 1 to 3 compatibility). After the first head, a missing entry fails closed.

### 4.8 Franking (§12.16)

- **F-1** `franking_tag = HMAC-SHA256(franking_key, label ‖ channel_id ‖ client_msg_id ‖ encode(EnvelopeContent))`. Tested by the pinned vector in `franking.spec.ts`.
- **F-2** The receiver checks the tag (§12.8.5 step 6), so a report can always prove what the recipients saw.
- **F-3** Takusen compares the tag in constant time. `reportSchema` caps `frankingKey` at 32 bytes but accepts a shorter key. A shorter key gives `verified: false`. Examine if the route must reject it.

### 4.9 Signed admin actions (§12.16)

- **G-1** `seq` and `prev_hash` form a chain from genesis. Tested by `admin.fuzz.spec.ts` (a flipped, dropped or reordered action throws).
- **G-2** The genesis is signed by the owner. Every later action needs the permission in the state before it.
- **G-3** Takusen checks signature, chain and match with the request. It does not replay permissions.
- **G-4** The replay accepts actions from a device that was revoked later (contract `// ponytail:` note). The audit must decide this.

### 4.10 Voice relay (§8, §12.10.1)

- **V-1** The media node accepts the first commit whose epoch is the room epoch and whose header leaf is the sender's reported leaf.
- **V-2** At most one transition is not executed. Two sessions never hold one leaf. Tested by `FuzzE2EEOps`.
- **V-3** Two `e2ee_invalid` reports evict the committer (4014). One member cannot disconnect the room.
- **V-4** Identify refuses a client without `e2ee.version = 1` (4012) and a token without `deviceId` (4004).

## 5. Known limitations

- **L-1 ts-mls is not audited.** Hachiman uses ts-mls 1.6.4 (plan, note 1). `smoke.spec.ts` pins the library behavior that the design uses.
- **L-2 Browser host trust.** A hostile server can send hostile JavaScript to the browser host. The browser deployment must send the CSP as a response header on every response, Worker scripts included. The meta tag does not cover Workers.
- **L-3 Electron key copies.** Electron main cannot zero every copy of the wrap key. `safeStorage` takes a string, and the IPC structured clone is a copy.
- **L-4 Unverifiable MAC tags.** The DS accepts a commit with a changed `confirmation_tag` or `membership_tag`. Members then reject it, and the epoch stalls on their devices until a resync. A member can always break a group, so this is a denial of service only.
- **L-5 Fail closed, then auto-resync.** When a client rejects a commit that the DS accepted, the group stops on that device and the client raises `forkAlert` (`commit_rejected`). The Worker resyncs by external commit after waits of 1, 2, 4, 8 and 16 s, and the next `sync()` tries again (§12.8.7). A member that can make the DS accept a bad commit can thus make the other devices resync.
- **L-6 Group size.** The default cap is 500 leaves (`docs/e2ee-load-test.md`). At 500 leaves a full batch takes 0.43 s (deadline 5 s) and a join by Welcome takes 2.2 s (budget 10 s). At 1,000 leaves a join takes 8.3 s. The repo patches two ts-mls 1.6.4 defects (`patches/ts-mls@1.6.4.patch`): an unmerged-leaves check that rejected valid trees, and an encoder that overflowed the stack above 2,048 leaves. Upstream fixed both on `main` (PR #505 and the encoder rewrite). Auditors must review the patch.
- **L-7 History.** A leaked device store or recovery key exposes history (§12.11).
- **L-8 Voice roster.** The committer trusts the media roster for Adds. It cannot query gateway voice states.
- **L-9 No runtime test of WebRTC transforms.** `transform-worker.ts` has a typecheck only. No real browser ran the voice E2EE path, and the `webrtc-reviewer` review of `voice.ts` is still open.
- **L-10 Route handlers.** No test runs the Next route handlers, because they use Drizzle directly. The route-level zod schemas are module-private, so the fuzz tests cover their shared parts (`b64`, `fromB64`, `lib/wire.ts`, `reportSchema`) only.
- **L-11 Request size.** `src/middleware.ts` buffers bodies up to 10 MB. A very large `public_set` ratchet tree can hit this limit.
- **L-12 Renderer CSP.** `connect-src` allows every `wss:` host. The gateway gives the media signaling URL of each voice join at run time, and media nodes are placed per region, so the host list is not known at build time. Thus an injected script that can use the crypto Worker can send data to any `wss:` host. A fix needs one media domain with a wildcard subdomain, or a host list from the region config. `style-src` keeps `'unsafe-inline'`, because Radix and the UI set inline style attributes. Inline styles run no script, but they let injected markup change the page (`apps/hachiman-electron/src/main/csp-policy.ts`).
- **L-13 Store rollback.** The device store (`src/store`) has no rollback protection. An attacker with access to the local disk can put back an old copy of the store: an older KT head, admin state, `seen` rows or membership rows. This is accepted. A local disk attacker is out of scope in the threat model.
- **L-14 Revoked-device signatures.** A revoked device can still sign envelopes for epochs before the Remove that the client processed (§12.8.5 step 4). The server sets the order and `created_at` of such rows.
- **L-15 KT freshness.** An inclusion proof shows that a key object is in the log, not that it is the newest entry of the user. The DS can serve an old DSK cert or hide a revocation entry from contacts (§12.14). A client that pinned `ktRequired: false` checks no proofs until it stores its first head.
- **L-16 Fork alert.** The AEAD failure count uses unauthenticated headers. A server can trigger a resync, but the rate limit allows at most one per group in 10 minutes, with exponential backoff (§12.8.7).

## 6. Fuzz and property tests

All targets run on every `test` command with a small budget. A longer run uses the commands below.

| Target | File | Invariant |
|---|---|---|
| Codec varints, structs, base64url | `pkgs/hachiman-crypto/src/codec.spec.ts` | Round trip, minimal encoding |
| Envelope and content codecs | `src/envelope/codec.spec.ts` | Decode or `CryptoError` only |
| Envelope open, plaintext | `src/envelope/envelope.spec.ts`, `service.spec.ts` | Never throws, never accepts a mutation |
| Attachment decrypt | `src/attachments/attachments.spec.ts` | `CryptoError` for every mutation |
| SFrame header and frame | `src/media/sframe.spec.ts` | `decodeHeader` throws only `CryptoError`, `decryptFrame` never throws |
| SFrame key ring | `src/media/transform.fuzz.spec.ts` | N-3, no plaintext passthrough, replay window |
| KT proofs and codecs | `src/kt/kt.fuzz.spec.ts` | K-1, K-2, S-4, canonical bytes |
| Admin actions | `src/admin/admin.fuzz.spec.ts` | S-3, G-1, canonical bytes |
| Identity, link, backup codecs | `src/identity/codec.fuzz.spec.ts` | `CodecError` only, canonical bytes |
| Invite record, bundle and auth codecs | `src/invites/codec.fuzz.spec.ts` | `CodecError` only, canonical bytes |
| DS module | `src/mls/ds.fuzz.spec.ts` | `checkCommit` never throws, S-6, inspectors, verifiers |
| `decodeB64url` (Go) | `cmd/hachiman-media/e2ee_fuzz_test.go` `FuzzDecodeB64url` | Strict §12.2 |
| Commit header (Go) | `FuzzParseCommitHeader` | Canonical prefix |
| Voice E2EE ops (Go) | `FuzzE2EEOps` | V-2 and room invariants, under joins, leaves, commits, trees, readies, invalid reports, raw JSON and timers |
| Voice token (Go) | `pkg/voicetoken/fuzz_test.go` `FuzzVerify` | S-5 |
| Client version (Go) | `cmd/hachiman-gateway/semver_fuzz_test.go` `FuzzSemver` | Exactly SemVer 2.0.0, ordered |
| Takusen parsers | `apps/takusen/src/lib/mls/__fuzz__/parsers.fuzz.test.ts` | Typed errors only, base64url agrees with `@hachiman/crypto`, `acceptEnvelope` binds group, channel, device and leaf |

`FuzzE2EEOps` makes a real `*websocket.Conn` over `net.Pipe`, so it binds no port.

## 7. Test vectors and how to run the tests

### 7.1 Pinned vectors

- `K_msg`: `envelope.spec.ts` ("matches the pinned K_msg vector"), computed with Node `crypto.hkdfSync`.
- SFrame key and salt: `sframe.spec.ts` ("matches the pinned vector and an independent HKDF").
- Franking tag: `franking.spec.ts`, computed with Node `crypto.createHmac`.
- Padmé table: `attachments.spec.ts` ("matches the table").
- Recovery key: §12.11.3 (`rk` = 0x00 … 0x1f gives `HRK1-000G4-0R40M-…-FP638`).
- KT: `kt.spec.ts` compares with a plain RFC 6962 MTH for all trees up to 64 leaves.

These vectors come from independent implementations in Node, not from the RFC appendices. An auditor can add the RFC 9605 Appendix C vectors.

### 7.2 Commands

Run from the repo root unless noted. Commands that bind 127.0.0.1 need a normal shell (not a sandbox).

```bash
# Crypto package: all specs, fuzz included (small budget)
pnpm -F @hachiman/crypto test

# Crypto fuzz only, 20 times the default runs
cd pkgs/hachiman-crypto && FUZZ_RUNS=20 npx vitest run fuzz --testTimeout=600000

# Takusen: all tests, fuzz included
pnpm -F @hachiman/takusen test

# Takusen fuzz only, a long run with another seed
cd apps/takusen && DATABASE_URL=postgres://test:test@localhost:1/test FUZZ_ITERS=200000 FUZZ_SEED=7 \
  node --import tsx --test src/lib/mls/__fuzz__/parsers.fuzz.test.ts

# Go: all tests (each fuzz target runs its seed corpus)
cd apps/hachiman-server && CGO_ENABLED=0 go test ./...

# Go: one fuzz target for 30 s (one target per command)
cd apps/hachiman-server
go test ./cmd/hachiman-media  -run '^$' -fuzz '^FuzzE2EEOps$'           -fuzztime 30s
go test ./cmd/hachiman-media  -run '^$' -fuzz '^FuzzParseCommitHeader$' -fuzztime 30s
go test ./cmd/hachiman-media  -run '^$' -fuzz '^FuzzDecodeB64url$'      -fuzztime 30s
go test ./pkg/voicetoken      -run '^$' -fuzz '^FuzzVerify$'            -fuzztime 30s
go test ./cmd/hachiman-gateway -run '^$' -fuzz '^FuzzSemver$'           -fuzztime 30s
```

Go writes a failing input to `testdata/fuzz/<Target>/` in the package. Commit it, so that `go test` runs it again.

## 8. Findings of the fuzz pass (2026-10-02)

| ID | Status | Finding |
|---|---|---|
| FZ-1 | Fixed | `Reader.utf8` let the `TypeError` of `TextDecoder` escape on bad UTF-8. Callers expect only `CodecError`. `codec.ts` now maps it to `CodecError('invalid UTF-8')`. |
| FZ-2 | Fixed | ts-mls reads an `optional` presence octet other than 0 or 1 as "absent" (`ts-mls/dist/src/codec/optional.js`). RFC 9420 and §12.2 allow only 0 and 1. `mls/wire.ts` `decodeMessage` and `decodeTree` now encode the decoded value again. They reject the input (`CryptoError` `Malformed`) when the two byte strings are different. Thus the DS accepts only the canonical encoding of commits, GroupInfos and ratchet trees. `mls/ds.fuzz.spec.ts` examines this. |
| FZ-3 | Fixed | `decodeHistoryBatch` accepted an empty key list, which the encoder cannot write. The decoder now rejects it. |
| FZ-4 | Fixed | `decodeHistoryBatch` accepted keys in any epoch order and duplicate epochs. The decoder now rejects epochs that are not strictly ascending. The encoder sorts the keys and removes duplicate epochs (the last key for an epoch stays), so a device cannot write a batch that it then rejects. `decodeLinkTransfer` also rejects two history batches with the same group id. Property tests are in `identity/codec.spec.ts`. The fuzz targets for `HistoryBatch` and `LinkTransfer` now require canonical bytes. |
| FZ-5 | Note | K-2: `verifyInclusion` alone does not bind the tree size (RFC 9162 behavior). |
| FZ-6 | Note | Go `decodeB64url("")` fails. TypeScript `fromB64("")` and `fromB64url("")` give zero bytes. No voice field may be empty, so the difference has no effect today. |

## 9. Checklist for auditors

1. Read §12 of `docs/gateway-protocol.md`, then `docs/e2ee-plan.md` "Implementation notes".
2. Run the commands of section 7.2. Make sure that all tests pass on your machine.
3. Examine every invariant of section 4. Record "holds", "broken" or "not checked" for each ID.
4. Examine each HKDF info string and each signature label in `constants.ts` against §12.2 and §12.3.
5. Examine that every random value (salts, keys, nonce prefixes, `client_msg_id`, recovery key) comes from `crypto.getRandomValues` or `@noble` randomness.
6. Examine every decoder for strictness: minimal varints, no trailing bytes, `optional` flags 0 or 1, fixed lengths. Include the FZ-2 fix.
7. Examine the ts-mls calls in `mls/index.ts` and `mls/ds.ts`, and the library paths that they reach (L-1).
8. Examine the §12.7.3 checks in `lib/mls/commits.ts` in order, and the inference of D-2.
9. Examine the compare-and-set and the transaction scope in `repo.drizzle.ts`.
10. Examine the §12.8.5 receive steps in `envelope/service.ts`, and the dedupe and rollback rule of step 10.
11. Examine N-4 and N-5 in `media/service.ts` and `media/transform.ts`.
12. Examine the media node state machine in `e2ee.go` against §8 and §12.10.1.
13. Examine the Worker boundary: `worker/permissions.ts`, `worker/rpc.ts`. Make sure that no private key crosses to the UI thread.
14. Examine the store: wrap key handling in both hosts, AAD, the Web Lock.
15. Decide G-4: is an admin action of a device that is now revoked still valid?
16. Decide F-3: must the report route reject a franking key shorter than 32 bytes?
17. Run each fuzz target longer than 30 s. Add each crash input to the corpus and report it.
