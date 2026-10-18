# End-to-end encryption for Hachiman: plan

## Context

Today the server can read everything:
- Takusen stores message text in plaintext (`messages.content`).
- It stores attachments as plaintext objects in S3 and serves them on a public `/files` route.
- Media nodes forward Opus and VP8 frames that any operator can decode.

The goal is end-to-end encryption (E2EE) for messages, attachments, voice, video and screen share in every channel type. Takusen, the gateway and the media nodes become relays for ciphertext. Only member devices hold keys.

The plan uses the research from this session: MLS (RFC 9420, RFC 9750), Discord DAVE, SFrame (RFC 9605), Matrix, Signal, WhatsApp, Wire and Messenger. It also uses a map of every code path that touches content, and an adversarial review of the first draft.

## Threat model

**Protect against:** an operator, a compromised server, or an attacker with access to the database, S3, Redis or the network. This attacker must not read, forge or replay content.

**The server can still:**
- See metadata: who is in which channel, who sends when, message and file sizes, voice presence, IP addresses.
- Refuse service, drop messages or delay them.
- Make its own accounts and give them guild roles. In public channels, which anyone can join, this is accepted, and the server may propose Adds to the public set group (see section 4). In DMs, group DMs and private channels, only a member can add someone, and the UI names who added whom (see section 4).

**Out of scope:**
- A compromised device.
- The browser host. A hostile server can send it hostile JavaScript, so it shows the label "trusts the server's code". The Electron host is the strong client.

## Decisions

### 1. Protocol: MLS for all key agreement

Use MLS (RFC 9420) with cipher suite 1 (`MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`). Each group records its suite. The X-Wing post-quantum hybrid (draft-ietf-mls-pq-ciphersuites) comes in Phase 4.

Why MLS:
- It gives forward secrecy and post-compromise security.
- Rekeying costs grow with log(n), not n.
- Each device is a separate member.
- It is the current standard: Discord DAVE, Wire, RCS Universal Profile 3.0.

Sender keys and Megolm have weak post-compromise security.

### 2. Library: OpenMLS (WebAssembly) in a Worker

- Use OpenMLS compiled to WebAssembly. It had an independent audit (SRLabs, May 2026), and Wire uses it in production.
- Fallback: ts-mls. It is pure TypeScript, but no one has audited it.
- All key material goes in a new workspace package, `pkgs/hachiman-crypto`, which runs in a dedicated Worker. The UI thread never holds private keys.
- `@hachiman/client` stays free of WebAssembly. It talks to the Worker through a narrow message interface.

### 3. Identity: cross-signing, device certificates, TOFU

**Keys:**
- **Master key (Ed25519):** made on the first device. It lives only on a primary device and in the recovery backup. No key ever comes from the Takusen password.
- **Device-signing key:** the master key signs it. It is on every device of the user.
- **Device certificate:** the device-signing key signs each device's MLS signature key.
- **MLS credential:** a BasicCredential `userId:deviceId`, with the certificate chain in an extension.
- **Clients reject any leaf without a valid chain.** This blocks "ghost devices" from the server.

**Linking a new device:** link it from an existing device by QR code or emoji SAS. The new device gets the device-signing key over that channel.

**Revocation:**
- The master key signs a device revocation. Takusen publishes it.
- The user's other devices commit Removes for the revoked device in every group.
- On revocation, rotate the device-signing key.

**Trust:**
- TOFU (trust on first use) pins each contact's master key.
- Users compare a safety number or scan a QR code.
- A changed key on a verified contact shows a blocking warning. On an unverified contact it shows a quiet notice.
- Users verify accounts, not single devices.

**Recovery:**
- The first device makes a high-entropy recovery key and shows it once. The key encrypts a versioned backup: the master key, plus one blob of history keys per batch of epochs. Takusen stores these blobs as opaque data.
- There is no passphrase backup. A self-hosted server has no HSM to stop offline brute force.
- The docs say that a leaked recovery key exposes all history.

**Password reset** recovers the account, not the keys. Without the recovery key, the user gets a new master key:
- Old devices are revoked.
- Contacts see "security key changed".
- Old history becomes unreadable.

Reset must also revoke all sessions (today it does not).

**Later phase:** a key transparency log (an append-only Merkle log of master-key changes, with client self-checks).

### 4. Groups and the delivery service

- **Groups:**
  - **Public set group:** one MLS group per guild for all of its public channels, meaning the channels whose readers are exactly the users with VIEW_CHANNEL through @everyone. Those channels have the same readers, so one group serves them all. A join or leave then costs one commit, not one per channel.
  - **Private channel group:** one MLS group for each other text channel (a channel with its own reader set).
  - **DM group:** one MLS group per DM and per group DM.
  - **Voice group:** each voice session gets its own short-lived group, on the media node.
- **A channel that changes its reader set** moves between groups:
  - When an overwrite gives a public channel its own readers, a member's device makes a new group for it with the current readers. New messages go to that group. Old messages stay in the public set group.
  - When a channel becomes public again, new messages go to the public set group.
- **Who may add a member:**
  - **DMs and group DMs:** the creator's commit sets the members. Any member of a group DM can add people, and any member can leave. The DS queues Adds for the devices of the new members and Removes for the devices of the leaver (`dm_participants_changed`, contract §12.18). A new member reads only from its join (`history_visibility` joined).
  - **Private channels** (a channel where @everyone lacks VIEW_CHANNEL): when a user gains VIEW_CHANNEL, an online member's device commits the Add. The membership timeline records "A added B". The chat transcript does not show it.

    The server cannot add a member by itself. Role data is not signed, so a malicious server can still trick a member device into adding someone. The visible timeline entry is the defense. Signed admin actions come in Phase 4.
  - **Public set group:** a device asks to join when it first opens a public channel. It uploads a key package. Takusen checks VIEW_CHANNEL and queues an Add proposal as `external_sender` (see "Batched commits" below).

    In this group, and in no other, the server may propose Adds. This matches the threat model, because anyone can join a public channel. Members commit only key packages with a valid certificate chain.
  - **Fallback:** if no member device is online, the joiner adds itself by external commit against the GroupInfo that Takusen stores.
  - **External commits** are also allowed to resync a device's own leaf.
- **Removal:** when a user loses VIEW_CHANNEL, Takusen sends Remove proposals as the group's `external_sender`. This covers kick, leave, a role or overwrite change, a channel move, account delete, revocation and reset.

  Outside the public set group, Takusen may send only Remove proposals.
- **Batched commits:** Takusen holds pending proposals and starts the commits. It never makes a commit itself.

  An MLS commit makes the secrets of the next epoch, so its author can read the group. RFC 9420 lets an external sender propose but not commit. A server commit would make Takusen a member and would break E2EE.

  How a batch works:
  1. Takusen queues Add and Remove proposals per group in `mls_pending`.
  2. Every 2 seconds (configurable), or when a Remove arrives, Takusen sends the batch to one online member device. It picks the device with the lowest leaf index among those online.
  3. That device checks each proposal (a valid certificate chain on Adds, the rule above on who may propose), makes one commit for the whole batch, and sends Welcome messages to the joiners.
  4. If the device does not answer in 5 seconds, Takusen sends the batch to the next online device.

  The device does all of this automatically. Users take no action.
- **Pending Removes:** a client that holds pending Remove proposals must commit them before it encrypts, even if Takusen did not choose it for the batch. Until that commit, it refuses to send. This closes the window in which a removed device could still derive keys.
- **Takusen as delivery service (DS):**
  - It orders handshakes with a compare-and-set on `(group_id, epoch)` in Postgres. The first valid commit wins. The others get 409 and retry on the new epoch.
  - It rejects a commit when the resulting members include a user without VIEW_CHANNEL.
  - GroupInfo must be signed by a current member. A joiner checks the member list against the timeline.
- **Membership policy:** a shared `channelReaders(channelId)` built on `computeChannelPermissions`. Today only the gateway's `withVisibilityDiff` computes which permission edits change readers. Move that logic into a shared rule that Takusen also uses.
- **Retention:** keep handshakes for 30 days.
  - A device that is further behind does a resync by external commit. It then gets the missed history keys from the user's own devices or from the backup.
  - A client buffers envelopes for an epoch it has not reached until it has fetched handshakes by sequence number.

### 5. Messages: per-message keys from the epoch secret

MLS application messages delete their keys after one use. A client could then not decrypt stored history again after a reload, and could not share history. Therefore messages use the MLS exporter, as DAVE does for media:

- **Epoch secret:** `S_e = MLS-Exporter("hachiman message v1", group_id, 32)`.
- **Message key:** `K_msg = HKDF(S_e, "msg" ‖ leaf_index ‖ salt)`, with a random 32-byte salt per message and a nonce of zero.

  Each message has its own key. There is no counter state, so a reload or a second device cannot reuse a nonce.
- **AAD:** `{group_id, channel_id, epoch, sender_leaf, client_msg_id}`. `channel_id` stops the server from moving a message to another channel of the same public set group.
  - `client_msg_id` is a 128-bit random value chosen by the sender. The server-assigned `message_id` is not known when the sender encrypts.
  - Receivers reject a second message with the same `(group_id, sender_leaf, client_msg_id)`.
- **Envelope:** text, mentions, attachment pointers (key, hash, size, mime, name, dimensions), and the target of a reply, edit or delete.
- **Sender proof:** the sender's MLS leaf signature key signs the envelope hash and the AAD. A member who can derive `S_e` still cannot forge another member's messages.

  Signed messages are non-repudiable. The docs say so.
- **Forks:** a fork in group state gives a different `S_e`. A decrypt failure on a valid-looking envelope raises a fork alert.
- **Edits and deletes** reference `client_msg_id`. The receiver accepts them only when the signer belongs to the same account as the author of the original. The server also enforces author-only edit and delete on metadata. A delete removes only the ciphertext.
- **History for new members:** a per-channel setting `historyVisibility`.
  - `joined`: no past history. This is the default for DMs and private channels.
  - `shared`: the default for public guild channels. The member who committed the join (or the next member online) sends a history-key bundle inside the new epoch, signed by its leaf. Receivers check each old message's signature against its device certificate, and show "membership at that time not verified". Bundle size has a cap.
- **A user's own new devices** get history from the backup or from the linking device.
- **Limits:** server-side limits apply to ciphertext bytes.

### 6. Attachments: chunked AEAD, opaque blobs

- **Encryption:** a random key per file, AES-256-GCM, STREAM construction. Segments are 64 KiB, and the nonce is a counter plus a last-segment flag. This stops truncation and reordering, and bounds memory.
- **Padding:** ciphertext is padded to Padmé size buckets.
- **Metadata:** filename, mime, dimensions, size and blurhash move into the envelope. The server stores the ciphertext size and the uploader only.
- **Delivery:** `/files` serves `application/octet-stream`. The client decrypts each file in full into a blob URL. Streaming playback through a service worker comes later.
- **Thumbnails** use their own blob and key.
- **Avatars, guild icons and banners stay plaintext.** They are public profile data, and the docs say so.

### 7. Voice, video and screen share: DAVE-style

- **Delivery service:** the media node is the DS and `external_sender` for the MLS group of each voice room. A room lives on one node, so the media node can order commits.
- **Join:** the client sends a key package on `/voice`, signed by its certified device key. Media proposes Add.

  Members commit the Add only for a key package with a valid certificate chain. The participant list in the UI comes from the MLS tree, not from the server's roster.
- **Leave, kick, 4010 or 4011:** media proposes Remove.
- **Frame keys:** each sender's base key is `MLS-Exporter("SFrame 1.0 Base Key", ...)`, as in RFC 9605 §5.2. The SFrame KID packs the leaf index and the low bits of the epoch. Use AES-128-GCM with a full tag.
- **Codec prefix:** keep the codec prefix in clear, as DAVE does, and include it in the authentication:
  - VP8: 1 byte (delta frames) or 10 bytes (keyframes).
  - Opus: none.

  The SFU forwards RTP unchanged. It never parses payloads (confirmed in `pkg/media/sfu.go`).
- **Epoch change:** keep old-epoch keys for 10 s. There is no plaintext passthrough mode. A node refuses clients without E2EE from the first day.
- **Client:** one Worker per call, with `RTCRtpScriptTransform`. This works on Electron 39 (Chromium 142), current Chrome, Firefox 142 and later, and Safari 15.4 and later. There is no legacy-API fallback.
- **Sender keys** come from the KID and the leaf credential, not the RTP SSRC. The SFU rewrites SSRCs.
- **Speaking state** stays a client-sent op. The SFU negotiates no audio-level extension. The docs list speaking state as metadata.
- **Verification:** each pair of users has a safety code from both master keys. The call also shows the MLS epoch authenticator as a 30-digit code that all members can compare at one time.
- **Out of scope:** server-side recording. A recorder would have to be an MLS member.

### 8. Features that change

- **Mentions and notification sounds:** they are already client-side (`lib/mentions.ts`, `SoundService.messageSound`). They run after decryption.
- **Search:** later, as a local index in the client.
- **Link previews:** later, made by the sender.
- **Push notifications:** content-free when push arrives.
- **Moderation:**
  - The reporter forwards decrypted messages.
  - Rate limits use metadata.
  - Message franking comes in Phase 4.
  - No client-side scanning.
- **Typing, presence and voice state** stay plaintext metadata.

### 9. Rollout

The project is at the development stage. Per `feedback_dev_migrations.md`:
- Change the schema in place, then drop and reseed the dev database.
- There is no migration path from plaintext to E2EE.
- There is no mixed mode.

The gateway checks a client capability and a minimum version at IDENTIFY.

## Phases

Each phase ships by itself and keeps `docs/gateway-protocol.md` in step.

**Phase 0: foundations**
- `pkgs/hachiman-crypto`: the OpenMLS WebAssembly build, a Worker entry, and an encrypted IndexedDB store. The store's state is wrapped by a non-extractable WebCrypto key.
- `IPlatformService.secureStorage`: Electron uses `safeStorage` and refuses the `basic_text` backend on Linux. The browser uses an IndexedDB wrap key.
- A `devices` table, master and device keys, device certificates, a device id in IDENTIFY, and a gateway delivery scope `device:{id}`.
- CSP: add `'wasm-unsafe-eval'` and `worker-src 'self'` in `apps/hachiman-electron/src/main/csp.ts`, and add a CSP to the browser host. Add Vite Worker builds in both hosts.

**Phase 1: voice, video and screen share**
- New ops on `/voice`: `e2ee_key_package`, `e2ee_external_sender`, `e2ee_proposals`, `e2ee_commit`, `e2ee_welcome`, `e2ee_prepare_transition`, `e2ee_ready`, `e2ee_execute_transition`.
- Raise the WS read limit (64 KiB today) and the send queue. Do not put the ratchet tree in the Welcome. Send it in a separate frame.
- Frame transforms in `voice.ts`.
- The safety code and the epoch code in the call UI.

**Phase 2: DMs and group DMs**
- The Takusen DS tables and routes, and the message envelope.
- Encrypted attachments.
- Recovery key and backup, device linking by QR/SAS, and revocation.
- Membership timeline and safety numbers in the UI.

**Phase 3: guild channels**
- `channelReaders`, and the public set group per guild.
- Member-committed Adds in private channels. Queued Adds in the public set group.
- The batch scheduler: the `mls_pending` queue, choosing a committer, moving to the next device on timeout. It runs in the long-running Takusen gRPC process (`src/grpc/main.ts`), because Next.js has no background jobs.
- Remove proposals driven by permission changes.
- `historyVisibility` and history-key bundles.
- A load test of public-channel churn, to set the group size cap (see open decision 1).

**Phase 4: hardening**
- A key transparency log and signed admin actions.
- An external audit of `pkgs/hachiman-crypto` and of the DS rules.
- MLS light clients (an IETF draft), so that readers of large groups need not hold the full ratchet tree. Add this when OpenMLS supports it.
- Fuzzing of the envelope and frame parsers.
- The X-Wing cipher suite and message franking.

## Critical files

- **Takusen:**
  - `apps/takusen/src/db/schema.ts`:
    - New tables: `devices`, `device_revocations`, `master_keys`, `key_packages` (one-time and last-resort, atomic pop, rate-limited), `mls_groups` (guild public set or channel, epoch, group_info, suite, history visibility), `mls_pending` (queued proposals per group), `mls_handshakes` (ordered per group, 30-day retention), `device_inbox` (size cap), `key_backups`.
    - Change `messages` to `ciphertext`, `epoch`, `sender_device` and `client_msg_id`, and remove `content`.
    - Remove the plaintext name, mime and dimensions from `uploads`.
  - Routes:
    - `api/v1/channels/[id]/messages/*`: ciphertext body, byte limit.
    - `api/v1/uploads` and `files/*`: opaque blobs.
    - New `api/v1/devices` and `api/v1/mls/*`: key packages, commits, GroupInfo, inbox, backup. Rate-limit each one.
  - Libraries:
    - `lib/guild-access.ts`: add `channelReaders`.
    - `lib/events.ts`: device-scoped publish.
    - `lib/session-revocation.ts`: revoke sessions on reset.
    - `lib/admin-users.ts` `deleteUser` and `lib/guilds.ts` (delete guild or channel): send Removes, and delete the group rows.
  - A DS repo seam, like `MediaNodesRepo`, with Drizzle and in-memory versions.
- **Gateway:**
  - `cmd/hachiman-gateway/conn.go`: device id in IDENTIFY.
  - `bus.go`: the `device:*` scope.
  - `session.go`: delivery per device.
  - Handshakes are fetched over REST by sequence number, not from the 500-frame resume buffer.
- **Media:**
  - `cmd/hachiman-media/voice.go`: new ops, the DS role per room, the limits.
  - `pkg/media/sfu.go`: no payload change. Add a roster hook that orders add/remove before renegotiation.
- **Client:**
  - `pkgs/hachiman-client/src/types.ts`: ciphertext `Message` and `Attachment`, new events.
  - `rest.ts`, `gateway.ts`, `client.ts`.
  - `voice.ts`: transforms on transceivers 0 and 1, and on each `ontrack` receiver.
- **Shared UI:**
  - `services/MessagesService.ts` and `services/hachiman.ts`: decrypt before `messagesStore.upsert`.
  - `services/UploadService.ts`.
  - The attachment, lightbox and video components that set `src={fileUrl(key)}`: switch to decrypted blob URLs.
  - `shared/IPlatformService.ts`: `secureStorage`.
  - New screens for verification, linking and recovery.
  - `dev/preview/stubs.ts`: stub the crypto Worker.
- **Docs:** `docs/gateway-protocol.md` §1, §3, §4, §5, §6, §8, §10 and §11, plus a new E2EE section. Also update the READMEs and CLAUDE.md.

## Reuse

- `computeChannelPermissions` (`pkgs/hachiman-client/src/permissions.ts`) builds `channelReaders`. Clients use it to check commits.
- `withVisibilityDiff` (`cmd/hachiman-gateway/session.go`) is the model for which permission edits change readers.
- The `MediaNodesRepo` pattern (`apps/takusen/src/grpc/repo.ts`, `repo.in-memory.ts`) for the DS store.
- `lib/storage.ts` `putObject`, `getObjectStream` and `deleteObjects` stay as they are.
- The voice token (`pkg/voicetoken`) already binds `userId`, `sessionId` and the room to one node. Add a device id claim.

## Verification

- **Crypto package (vitest):** two to five simulated devices:
  - create a group, commit, remove and resync
  - share history.
  - Also check that the code rejects:
    - tampered or replayed envelopes, forged senders, and devices without a valid chain
    - Adds from a non-member, and sending while a Remove is pending.
- **DS ordering:** concurrent commits on one epoch, run on the in-memory repo. Exactly one wins.
- **Batch scheduler (in-memory repo):**
  - One commit covers a whole batch.
  - When the chosen device does not answer, the batch goes to the next device.
  - When no member is online, the joiner falls back to an external commit.
  - Clients reject an Add from the server in any group except the public set group.
- **Load test (Phase 3):** 10,000 members with churn. Measure the commit rate, ratchet tree size and catch-up time. Result: `docs/e2ee-load-test.md`. The default cap is 250 members.
- **Canary test:**
  1. Send a message whose text is a unique string.
  2. Check that the string is in no Postgres column, no S3 object and no Redis frame.
- **Media (Go tests):**
  - the new ops, Welcome delivery, and Remove on 4010/4011
  - a capture of forwarded RTP payloads, which must differ from the plaintext frames.
- **Cross-client calls:** Electron, Chrome, Firefox and Safari in each pair. Check audio, screen share and rejoin, and that the codes match.
- **CSP:** update `csp.test.mts`.
- **Commands:**
  - `pnpm -F @hachiman/client test`
  - `pnpm -F @hachiman/takusen test`
  - `pnpm -F @hachiman/hachiman-electron test`
  - `cd apps/hachiman-server && CGO_ENABLED=0 go test ./...`
  - `tsgo` typecheck in every package

## Open decisions (defaults chosen, change in review)

1. **E2EE in large public channels.** Decided: yes. Reads cost the same at any guild size. The cost is membership churn: each join or leave is a commit that every member device applies, and a joiner downloads a ratchet tree whose size grows with the member count.

   The plan limits this cost:
   - One public set group per guild.
   - Batched commits that Takusen starts.
   - Light clients later.

   The Phase 3 load test measures commit rate, tree size and catch-up time at 10,000 members. It set the default cap to 250 members (`docs/e2ee-load-test.md`). Note that E2EE in a public channel protects little, because anyone can join.
2. **History for new members.** Default: `shared` in public channels, `joined` in DMs and private channels.
3. **The browser host.** Default: supported, with the "trusts the server's code" label.
4. **Recovery.** Default: a recovery key only, no passphrase.
5. **The MLS library.** Decided: ts-mls 1.6.4 (Implementation note 1).

## Implementation notes

These notes record the decisions made at implementation time. `docs/gateway-protocol.md` §12 is the normative contract. Where a note changes the plan above, the note applies.

### 1. Library: ts-mls

- The library is ts-mls 1.6.4. It is the fallback that decision 2 names.
- No Rust toolchain exists here for an OpenMLS WebAssembly build. The OpenMLS builds on npm are GPL-licensed or stubs.
- This note decides open decision 5.
- ts-mls is pure TypeScript under the MIT license. It runs in the browser, in a Worker and in Node.
- No one has audited ts-mls. The Phase 4 audit covers it, together with `pkgs/hachiman-crypto` and the DS rules.
- No WebAssembly is necessary. Thus the hosts do not add `'wasm-unsafe-eval'` to the CSP. They add only `worker-src 'self'`.
- `pkgs/hachiman-crypto/src/smoke.spec.ts` pins the library behavior that the design uses. Keep it as a permanent test. If an upgrade breaks it, review the design.

What the smoke test shows:
- Cipher suite 1 supports these operations: create, Add with Welcome, a Remove from an external sender that a member commits, an external commit from GroupInfo with the ratchet tree, `mlsExporter`, the epoch authenticator, and a state round trip through `encodeGroupState`.
- The ratchet tree can travel apart from the Welcome. The DS can read a PublicMessage commit without group state. It can check a GroupInfo signature and the tree hash.
- Leaf node extensions survive Adds, external commits and update paths. The authentication service sees each credential.
- ts-mls can make a group with a custom credential type, but it cannot decode the state again. Thus Hachiman uses BasicCredential `userId:deviceId` and puts the certificate chain in a leaf extension (0xF1A0).
- ts-mls encodes `external_senders` as one ExternalSender without the RFC vector prefix, and indexes senders by extension position. Hachiman uses exactly one external sender in the first extension. Thus index 0 is the same in both readings.
- The commit callback of ts-mls is synchronous. Clients therefore check certificate chains before `processMessage`, with synchronous Ed25519 from `@noble/curves`.
- The X-Wing suite (83) works for create, Add, Welcome and the exporter.
- ts-mls has no light-client or partial-tree mode. A join without the full ratchet tree fails. Light clients are deferred until the library supports them (§12.17 gives the condition).
- An update path copies the old leaf extensions, and a commit cannot set new ones. Thus a device changes its certificate chain only by a resync external commit with a new key package. After a DSK rotation, each device resyncs its leaf in every group (§12.4).

### 2. Voice groups: members commit, the media node orders

- The Go media node has no MLS library. Thus it does not sign proposals, and it is not an external sender.
- The media node relays key packages, Welcomes, commits and roster changes. It orders commits: the first valid commit per epoch wins. It reads the group id and the epoch from the first bytes of the commit.
- The online member device with the lowest leaf index commits. It commits Adds only for key packages with a valid certificate chain. It commits Removes for participants who left. When it does not commit in 5 s, the next member takes the role.
- This is stronger than decision 7 of the plan, because the server signs nothing in a voice group.
- The cost: a hostile media node can say that a participant left, or hide that a participant left. The first case is a denial of service. In the second case, the participant keeps the keys only while the server keeps the session open.
- When two members report a bad commit, the media node closes the committer with 4014. Thus one member cannot disconnect the whole room.
- The committer does not check that a joiner is in the voice channel (gateway voice states). `DsTransport` has no voice-state query. The committer checks the chain and that the credential equals the roster entry from the voice token claims. Thus it trusts the media roster for Adds. This is the accepted cost above: a hostile media node can already decide who is in the room.
- The final voice op set is in contract §8. It replaces the op list of Phase 1. There are no `e2ee_external_sender` and `e2ee_proposals` ops.
  - Media to client: `e2ee_roster`, `e2ee_key_package`, `e2ee_commit_rejected`, `e2ee_prepare_transition`, `e2ee_welcome`, `e2ee_ratchet_tree`, `e2ee_execute_transition`.
  - Client to media: `e2ee_commit`, `e2ee_ratchet_tree`, `e2ee_ready`, `e2ee_invalid`.

### 3. Takusen uses ts-mls in Node

- Takusen signs Remove proposals with `proposeExternal`. It signs Add proposals only in the public set group.
- All handshakes use PublicMessage framing. Thus Takusen can decode each commit, check the GroupInfo and the tree that the committer uploads, and enforce VIEW_CHANNEL on the next member list.
- Messages never use MLS application messages. They use the envelope of section 5 (contract §12.8).
- Takusen signs one proposal per pending item and epoch. It appends each proposal to the handshake stream before a batch uses it. Thus every member holds each proposal that a commit references.
- Takusen gets the stored state of the previous epoch for each commit check. It applies the proposals to the previous leaves and compares the result with the uploaded tree. Thus a commit cannot hide an Add.

### 4. Other decisions

- **One binary format.** Every Hachiman object uses the RFC 9420 presentation language (`src/codec.ts`). JSON wires carry the bytes as base64url without padding.
- **Device keys.** Each device has one MLS signature key for all groups, and an X25519 key for device messages. The device certificate holds both.
- **Signatures on messages.** The receiver checks the signature with the sender's device certificate, not with the leaf of that epoch. Thus history from a bundle or a backup can be checked without old trees.
- **Server epoch check.** Takusen rejects an envelope of an older epoch. The one exception is the epoch just before the current one, when the newest commit removed no leaf and is less than 10 s old.
- **History visibility.** The group descriptor extension holds it, so MLS authenticates it. REST only mirrors it. DMs stay `joined` in v1.
- **Password reset.** A reset revokes all sessions and all devices on the server. A password change revokes the other sessions and keeps the devices.
- **Franking.** Every envelope carries the franking tag from the first day. The report route that checks it is Phase 4.
- **Key packages.** Takusen claims key packages for the Adds that it queues. Clients never claim the key packages of other devices.
- **One tab per device.** A Web Lock stops two Workers from using one device store.
- **channelReaders.** It lives in `apps/takusen/src/lib/mls/readers.ts`, next to the DS that uses it most. `lib/guild-access.ts` calls it.
- **Schema names.** The contract names are final. `messages` has `envelope`, not `ciphertext` (Critical files).
- **Joiner check (decision 4).** A joiner has no timeline. It compares the leaves of the tree with its own `channelReaders` result. It shows each extra user as a timeline entry in the channel.
- **Envelope limit.** The default is 32 KiB. The largest valid message is about 18.3 KB.
- **Edits.** An edit keeps the `client_msg_id` of the original. The receiver keeps the highest `sent_at_ms` per message. Thus the server cannot roll back an edit.
- **Revocation by sign-out.** A device signs its own `signed_out` revocation with its MLS key. Thus a stolen bearer token cannot sign out other devices.
- **Password reset.** A reset also marks the master key as superseded. The user then restores the old master key or makes a new one. A bearer token alone cannot replace a current master key.
- **Deleted users.** A Remove is keyed by its leaf index. Thus a user delete does not lose the queued Removes, and the orphan leaves do not block later commits.
- **Signed admin actions.** The replay uses the permission rules of `@hachiman/client/permissions`. Thus `@hachiman/crypto` needs the workspace dependency `@hachiman/client`. Each language keeps one permission implementation.
- **Group size cap.** A public set group has at most 500 leaves by default (`PUBLIC_SET_MAX_MEMBERS`, `TAKUSEN_PUBLIC_SET_MAX_MEMBERS`). A join above the cap gets `GroupFull`.
- **Group size cap, measured.** The Phase 3 load test (`docs/e2ee-load-test.md`, bench `pkgs/hachiman-crypto/src/mls/load.bench.ts`) set the cap to 500. It was 10,000. After three optimizations, a full batch takes 0.43 s at 500 leaves (deadline 5 s) and a join by Welcome takes 2.2 s (budget 10 s). A group of 10,000 leaves fails the time budgets of the test. The repo patches two ts-mls 1.6.4 defects that blocked large groups (`patches/ts-mls@1.6.4.patch`, fixed upstream on `main`). "How to increase the cap" in the load test document lists the changes that allow a higher cap.
- **Public history and DS membership.** A `public_set` group takes its readers from the DS guild member list. Signed admin actions do not cover guild membership. When the descriptor says `shared`, the committer sends a history bundle to each new user that the DS adds (contract §12.11.2). A malicious server can add an account that it controls and get the public channel history. This agrees with the threat model: public channels accept membership that the server controls. The behavior does not change. Private history belongs in `channel` groups.
- **QR codes.** The UI has a small QR encoder. It reads QR codes with `BarcodeDetector` where the browser has it. Every host also accepts a pasted code, and SAS mode needs no camera.

### 5. Deviations found in the code

- **No SFU roster hook.** `pkg/media/sfu.go` needed no change and has no roster hook (Critical files item). The add and remove order of voice members is in `cmd/hachiman-media/e2ee.go`. The check that the SFU forwards RTP payloads byte-identical is the pion loopback test in `cmd/hachiman-media/voice_test.go`, not a test in `pkg/media`.
- **Fuzzing.** The fuzzing of the envelope and frame parsers (Phase 4) is done as fast-check property tests in the crypto specs (`*.spec.ts` and `*.fuzz.spec.ts`), as Go native fuzz targets in `apps/hachiman-server`, and as seeded fuzz tests of the Takusen parsers (`apps/takusen/src/lib/mls/__fuzz__`). `docs/e2ee-audit-scope.md` lists every target, the commands and the findings.
- **Group size cap.** See "Group size cap, measured" in note 4.
- **Tests that need devDependencies.** The browser secure-storage test (`apps/hachiman-browser/src/platforms/browser/secure-storage.test.mts`) needs `fake-indexeddb`, and the shared-UI tests need `vitest`. Both need a `pnpm install` outside the sandbox. Until then, the secure-storage test is skipped.
