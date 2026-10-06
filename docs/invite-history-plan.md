# Invites with history, and pages for new members: plan

## Context

A new member of a guild cannot read old content until a member device that holds the keys is online. The server holds only ciphertext, so it cannot open the content for anyone (`docs/e2ee-plan.md`, contract §12). Two cases cause problems now:

- **Pages.** A user who joins a pages channel sees "Waiting for a member to share this page" until a member re-encrypts the page in the current epoch (`docs/pages-channels-plan.md`, "Compaction and access by new members"). Only a client that has the page open does this (`apps/hachiman/src/services/docs/DocProvider.ts`). An idle page can stay closed to a new member for a long time, even while members are online.
- **History.** A new member gets the message history of a `shared` channel only from a history bundle (§12.11.2). A committer sends it, so a member device must be online.

This plan has two parts:

1. **Pages for new members** (Part A). A new reader of a pages channel can always open the current page content. Message history can stay closed. This part needs no invite change.
2. **Invites with history** (Part B). An administrator can make an invite that carries history. The new member reads it with no member online. Other invites carry no history, and the invite dialog says so.

**Constraint:** the server must not be able to read content. Thus the server must never hold a key that opens content. A "delegate key" that the server keeps and uses for the inviter is key escrow, and this plan rejects it. A member device makes every key before it is used, and the server stores only ciphertext.

## Terms

- **Reader:** a user with VIEW_CHANNEL on a channel.
- **Administrator:** a user with the ADMINISTRATOR permission in the verified admin state of the guild (§12.16). An administrator can read every channel. Members check the permission on their own devices, from the signed admin chain. They do not trust the REST role data for it.
- **Current state of a page:** the newest snapshot and the updates after it. The update log before the snapshot is page edit history, and this plan does not give it to new members.

## Part A: pages for new members

### A.1 Decision: page content is current state, not history

`historyVisibility` controls chat history only. A reader of a pages channel can always read the current state of each page, also when the channel is `joined`. The current pages plan already says this ("This works with `historyVisibility = joined` too"). This part makes it work without a member that has the page open.

### A.2 Options

| Option | How it works | Result |
|---|---|---|
| **1. Pointer re-wrap after a join (chosen)** | A member device that processes a commit that adds a leaf re-wraps the snapshot pointer of each page in the new epoch | The page opens as soon as one member processes the join commit. Small cost (see A.3) |
| 2. Page bundle per join | The committer sends one sealed bundle with all page pointers to the new device, as a history bundle | Works, but needs a new inbox kind. It helps only the one new device. Option 1 helps every later reader with the same work |
| 3. Page keys in the Welcome GroupInfo | Put the page keys in a GroupInfo extension | Rejected: the server stores GroupInfo for external commits, so the server could read the keys |
| 4. A long-lived page key per channel | Encrypt pages with a key that does not change with the epoch | Rejected: the new member still needs the key from a member, and a removed member keeps it |
| 5. Invites with page pointers (Part B) | An invite bundle has the page pointers | Opens pages with no member online, but only for administrator invites |

### A.3 Pointer re-wrap

The snapshot blob in S3 is encrypted with its own random `fileKey` (§12.20 `DocSnapshotPointer`). Only the small `doc_snapshot` envelope is in an epoch. Thus a member does not need to encrypt the page again. It encrypts the same pointer again in the new epoch:

1. **Trigger.** A member device processes a commit that adds a leaf of a user that had no leaf before (an Add or an external commit join) in a group of a pages channel. The trigger is in the crypto Worker (`GroupService`), not in `DocProvider`, so it also runs when no page is open.
2. **Who does it.** The committer does it immediately after the commit is accepted. A member that is online then is the committer. Every other member device that processes the commit starts after a random delay of 2 to 10 s and stops when the page already has a snapshot in the current epoch. When nobody is online (an external commit join with no members online), the first member that comes online and processes the commit does it.
3. **What it sends** for each page of the channel:
   - **No updates after the snapshot:** a new `doc_snapshot` envelope in the current epoch with the same `uploadId`, `fileKey`, `sha256` and `size`. There is no S3 write.
   - **Updates after the snapshot:** the device loads the page, merges the updates, and posts a full new snapshot, as `DocProvider` does now.
4. **Server rule.** `POST /pages/:pageId/snapshots` accepts a re-wrap: the same `baseSeq` and `uploadId` as the newest snapshot, in a newer epoch of the same group. This is compare-and-set on `(baseSeq, epoch)`. A loser gets 409 and does nothing more. The S3 object stays, and no upload is claimed again.
5. **Titles.** Title envelopes are also in an epoch. The same pass re-wraps the title of each page (`PATCH` with the same title, new envelope) when the title envelope is of an older epoch.

**Cost.** One small envelope for each page with no updates after its snapshot. One full snapshot for each page with updates after its snapshot. Takusen batches Adds (every 2 s, `TAKUSEN_MLS_BATCH_INTERVAL_MS`), so a batch of joins causes one pass. A channel with many pages makes a large pass. See "Open decisions".

**Security.** A re-wrap gives the new member the current state of each page, and nothing more. This is the intended access of a reader. A removed member gets no new envelope, because the re-wrap is in an epoch where its leaf is removed. A removed member who kept an old `fileKey` can open the old blob only if the server gives it the blob. This is the same as today.

### A.4 What stays

- An external commit join with no member online still waits until one member comes online. No design can close this gap without a key holder, except an invite that carries the keys (Part B).
- Message history follows `historyVisibility` as before.

## Part B: invites with history

### B.0 Invite limits (all invites)

These rules apply to every invite, with or without history. Today a user with CREATE_INSTANT_INVITE can send `maxAgeSeconds: 0` and make an invite that never expires (contract §4, line "Invite defaults").

- **A user who is not an administrator makes only limited invites.** `maxAgeSeconds` must be from 1 to 86400 (24 hours). Takusen rejects `0` and larger values from a user without ADMINISTRATOR with 403 `MissingPermissions`. The dialog shows only the choices up to 24 hours.
- **Only an administrator makes a permanent invite** (`maxAgeSeconds: 0`, no expiry). A permanent invite has these requirements:
  1. **Revocable.** An administrator or a user with MANAGE_GUILD can revoke it with `DELETE /invites/:code`, as now. The invite list (`GET /guilds/:id/invites`) shows permanent invites first, marked "Permanent", each with its creator and a Revoke button. Revoking stops new joins at once. Members who joined already stay members.
  2. **A security warning.** Before Takusen creates the invite, the dialog shows a confirmation that the administrator must accept: "A permanent invite never expires. Anyone who gets this link, now or later, can join the server. A link in a public place, a forwarded message or a screenshot can let unknown people in. Revoke the invite when you do not need it." For a permanent invite with history, the dialog adds: "Anyone who gets this link can also read the history and pages of these channels: <scope>. This continues until you revoke the invite. History that someone read before the revoke stays read." The REST body gets `acknowledgedPermanent: true`. Takusen rejects a permanent invite without it (400 `InvalidBody`), so that another client cannot skip the warning.
- **A creator who loses ADMINISTRATOR.** Takusen revokes the permanent invites of that user in the same transaction as the role or member change. The user cannot keep an invite that their role no longer allows.
- **Contract change:** §4 invite defaults and the `POST /guilds/:id/invites` row get the limits, the 403 and `acknowledgedPermanent`. `Invite` gets no new field: `expiresAt: null` already means permanent.

### B.1 Rules

- **Only an administrator can make an invite with history.** The invite dialog shows the option "Include history" only to an administrator. The default is off.
- **Other invites carry no history.** The invite dialog says: "This invite does not include message history. The new member sees pages, and the history of the channels that they can see, only when a member shares it."
- **Scope.** An invite with history covers the channels that the invitee can see when they join. Invites do not give roles. Thus, at the time of creation, the scope is the channels where @everyone has VIEW_CHANNEL, from the verified admin state. The administrator's device computes the scope and signs it. A later role or overwrite change does not make the scope larger.
- **Limits.** An invite with history has a maximum of 1 use by default. It expires after 24 hours by default. The administrator can make it permanent (B.0) or remove the use limit, with the warning of B.0. A revoke deletes the bundles. In the record, `expires_at_ms = 0` means permanent and `max_uses = 0` means no limit.
- **Revoke reaches the members.** Takusen sends a new gateway event `INVITE_DELETE` `{guildId, code}` to the guild on a revoke (contract §6, a new event; today no invite event exists). A member device that gets it stops sending bundles for the invite, and rejects later `invite_auth` joins with that `code_hash`. A device that was offline learns the revoke from `GET /guilds/:id/invites` before it sends a bundle.

### B.2 The invite key

The administrator's device makes a 32-byte random `invite_seed` and derives two key pairs from it:

```
hpke_ikm = HKDF-SHA256(salt = "", IKM = invite_seed, info = "hachiman invite hpke v1", 32)   → X25519 key pair (HPKE, suite of §12.5)
sign_ikm = HKDF-SHA256(salt = "", IKM = invite_seed, info = "hachiman invite sign v1", 32)   → Ed25519 key pair
```

The link is `https://<host>/invite/<code>#k=<base64url(invite_seed)>`. Browsers do not send the part after `#` to the server. Only the person who has the link has the seed. The server never gets it.

### B.3 The invite record

The administrator's device signs a record and sends it with `POST /guilds/:id/invites`:

```
struct {
  uint8 version = 1;
  opaque guild_id[16];
  opaque code_hash[32];              // SHA-256 of the invite code
  opaque hpke_public[32];
  opaque sign_public[32];
  opaque channel_ids<V>;             // the scope: 16 bytes each, sorted
  uint64 admin_chain_seq;            // the admin state that the scope comes from (§12.16)
  uint64 expires_at_ms;
  uint32 max_uses;
  opaque creator_device_id[16];
} InviteRecord;

struct {
  InviteRecord record;
  opaque signature<V>;               // Ed25519 by the creator's device-signing chain, label "InviteRecord"
} SignedInviteRecord;
```

A member device accepts a record only when all of these are true:

- The signature chain of the creator device verifies (§12.4).
- The creator has ADMINISTRATOR in the verified admin state at `admin_chain_seq`, and also in the current one.
- Every channel in the scope has VIEW_CHANNEL for @everyone at `admin_chain_seq`.
- The record has not expired (`expires_at_ms` is 0 or in the future), and the invite is not revoked.

### B.4 Invite bundles

An invite bundle is a sealed set of keys for one invite and one group:

```
struct {
  uint8 version = 1;
  opaque code_hash[32];
  opaque group_id<V>;
  HistoryKey keys<V>;                // §12.11.2: epoch secrets S_e, ascending
  DocSnapshotPointer pages<V>;       // the newest pointer of each page in the channels of this group (empty if none)
  opaque sender_device_id[16];
  opaque signature<V>;               // SignWithLabel(sender MLS signature key, "InviteBundle", ...)
} InviteBundleContent;

InviteBundle = HPKE-Seal(hpke_public, info = "hachiman invite bundle v1", aad = code_hash ‖ group_id, encode(InviteBundleContent))
```

Who sends bundles:

1. **At creation**, the administrator's device sends one bundle for each group of the scope. Each bundle has the epoch secrets that the device holds (at most `HISTORY_BUNDLE_MAX_EPOCHS`, newest first) and the page pointers.
2. **While the invite is active**, the committer of each commit in a group of the scope sends a bundle with the secret of the new epoch. When a page pointer changes, the sender of the new snapshot also sends it. Thus the invite gets the content of the time between creation and use. A member is online when it writes content, so this needs no extra member online. Each device checks the record (B.3) before it sends.

Takusen stores the bundles in a new table `invite_bundles` (invite id, group id, seq, bytes). It deletes them when the invite expires, is revoked, or reaches `max_uses`. A cap of 4 MiB for each invite limits the storage.

### B.5 Redeeming the invite

1. The client reads the seed from the fragment and removes the fragment from the address bar.
2. It gets `GET /invites/:code`, which now also returns the `SignedInviteRecord`, and checks the record (B.3). The new user has no pinned keys for the administrator. Thus this is first contact, and the client trusts the keys through key transparency (§12.14), as for any first contact.
3. It joins the guild with `POST /invites/:code`, as now.
4. It gets the bundles (`GET /invites/:code/bundles`; the caller must be a member who joined with this code), opens them, checks each signature, and stores the epoch secrets. Messages that decrypt with these keys get `membershipVerified = false`, as with a history bundle.
5. It joins each group of the scope:
   - **`public_set`:** by external commit, as now.
   - **`channel`:** by external commit with an invite authorization. The new leaf has a leaf extension `invite_auth` with the `SignedInviteRecord` and an Ed25519 signature with the invite sign key over the leaf's signature key. Members and the DS accept the external commit when the record is valid (B.3), the group is in the scope, and the signature verifies. This changes the policy table of §12.7.5: "External commit (join)" in `channel` also allows a valid `invite_auth`.
6. It opens the pages from the bundle pointers, with no member online.

### B.6 Security implications

**What the server cannot do**

- **Read content.** The server stores the bundles, but it does not have the seed. It sees the record, the scope (channel ids) and the bundle sizes.
- **Make an invite with history.** The record needs a signature from an administrator device. Members check it against the signed admin chain, not against REST roles.
- **Let its own account in with the invite authorization.** The external commit needs a signature with the invite sign key. Only the seed gives this key.
- **Make the scope larger.** The scope is in the signed record, and members send bundles only for groups in the scope.

**What changes, and the risks**

- **The link is a bearer secret.** Anyone who has the full link gets the history in the scope: a forwarded message, a screenshot, a link in a public place, browser history or a link preview service. This is the largest risk. Mitigations: the option is off by default, 1 use and 24 hours by default, a warning in the dialog, revoke, and the bundles are deleted after the last use. A revoke does not help after a use: history that was read stays read.
- **A permanent invite with history makes this risk unlimited in time.** The link opens the scope until someone revokes it, and it also opens content written after creation, because members keep sending bundles. A leak that nobody notices gives continuous access to the scope. The only control is revoke. Thus B.0 requires the warning and an acknowledgment, the invite list marks permanent invites, and the timeline records each permanent invite with history. A server that hides a revoke from members (no `INVITE_DELETE`) makes members send bundles for longer. This gives nothing to the server, which cannot open them, but it extends access for a person who has the link.
- **A permanent invite without history** gives no content. It lets anyone with the link join, and then read what @everyone can read from that point. This is the same as a Discord permanent invite.
- **Single use is enforced by the server.** A malicious server can give the bundles to more people than `max_uses` allows. Each of them also needs the seed. Thus this risk is only for people who already have the link.
- **History for more people.** A `joined` channel that is in the scope also gives its history through the invite. Thus the administrator makes this choice for the channels of the scope. The dialog lists the channels in the scope, and marks each `joined` channel.
- **Forward secrecy.** An epoch secret in a bundle opens every message of that epoch. When an attacker gets the seed and the stored bundles before they are deleted, the attacker gets this history. This is the same as the risk of the recovery key backup, but limited to the scope and to the life of the invite.
- **A web client served by a malicious server** can read the fragment and send it to the server. This is the known limit of E2EE in the browser host, and it also applies to all other keys in the browser. The Electron host does not have this risk.
- **A removed or demoted administrator.** Members check the record against the current admin state before each bundle and each `invite_auth` join. When the creator loses ADMINISTRATOR, the invite stops: members send no new bundles and reject the join. Takusen also revokes the invites with history of that user. Bundles that were already sent stay readable to a person with the link, until Takusen deletes them.
- **A compromised administrator device** can make invites with history and give them to an attacker. This is no new risk: that device can already read all channels. The timeline and the invite list show each invite with history, with its creator.
- **Metadata.** The server learns which invites carry history, and the scope.
- **Trust of the new member in the record.** The new user has no earlier contact with the administrator. The client checks the record through key transparency. When KT is off on the deployment, the server could give a false record and false bundles. The result is wrong content shown to the new user, not access to real content.

**Not in this plan:** invites that give roles (then the scope could include private channels), and history for a user who joins in another way (for example, when a role gives them a channel).

## Phases

1. **Pointer re-wrap (Part A).** The trigger in `GroupService`, the re-wrap and title re-wrap pass, the server rule for re-wrap snapshots, and the contract (§4 Pages, §12.20). This part does not depend on Part B.
2. **Invite limits (B.0).** The 24-hour limit for users without ADMINISTRATOR, permanent invites for administrators with the warning and `acknowledgedPermanent`, the "Permanent" marks and Revoke in the invite list, and the revoke on loss of ADMINISTRATOR (contract §4 invites). This phase does not depend on the others, and can ship first.
3. **Invite record and dialog.** The seed, the record, the administrator check, the scope, the dialog text for invites with and without history, and the limits (contract §3 `invites`, §4 invites).
4. **Invite bundles.** Bundles at creation and on each commit, the storage and deletion in Takusen, and redemption with history and page pointers (§12.11, §12.12).
5. **Invite authorization for `channel` groups.** The `invite_auth` leaf extension and the policy change (§12.7.5). Until this phase, an invite with history covers only `public_set` groups.

## Critical files

- `docs/gateway-protocol.md`: §3 (`invites`, `invite_bundles`), §4 (invites, page snapshots), §12.7.5 (policy table), §12.11 (invite bundles), §12.12 (routes), §12.20 (re-wrap).
- `pkgs/hachiman-crypto/src/api.ts`, `src/constants.ts`: invite methods, bundle limits, labels.
- `pkgs/hachiman-crypto/src/mls/service.ts`: the re-wrap trigger after a join commit, the invite bundle on each commit, the `invite_auth` check in the policy.
- `pkgs/hachiman-crypto/src/identity/`: the invite record, its signature and its check.
- `apps/takusen/src/app/api/v1/guilds/[id]/invites/route.ts`, `apps/takusen/src/app/api/v1/invites/[code]/route.ts`: the record, the bundles, the limits.
- `apps/takusen/src/lib/docs/`: the re-wrap compare-and-set in `DocsRepo` (both implementations).
- `apps/takusen/src/lib/mls/`: the `invite_auth` external commit rule, and bundle storage in `MlsRepo` (both implementations).
- `apps/takusen/src/db/schema.ts`: the new columns and table, with a new migration.
- `apps/hachiman/src/services/docs/DocProvider.ts`, `DocsService.ts`: pages that open from a re-wrapped pointer or an invite pointer.
- `apps/hachiman/src/components/settings/invite-options.tsx`, `apps/hachiman/src/services/InviteService.ts`: the dialog and the redemption.

## Verification

- **Re-wrap:** a member adds a user to a private pages channel and closes the app. The new user opens every page, also pages that nobody opened. A page with updates after its snapshot also opens.
- **External commit join:** a user joins a public pages channel when no member is online. The page waits. When one member comes online, the page opens without the member opening it.
- **Invite with history:** an administrator makes an invite and goes offline. A new user redeems it and reads the history and pages of the channels in the scope. Content written after creation is included.
- **Rules:** a user without ADMINISTRATOR cannot make an invite with history, and the dialog shows the text for an invite without history. A record from a non-administrator, a changed scope, or a demoted creator is rejected by members.
- **Invite limits:** a user without ADMINISTRATOR gets 403 for `maxAgeSeconds` 0 or above 86400, and the dialog offers nothing above 24 hours. An administrator gets 400 for a permanent invite without `acknowledgedPermanent`, and sees the warning in the dialog. A revoked permanent invite fails to join at once. When the creator loses ADMINISTRATOR, their permanent invites are revoked. A revoke of an invite with history stops new bundles, and members reject its `invite_auth` join.
- **Server attacks (unit tests with a fake DS):** a changed record, a bundle for another group, an external commit without a valid `invite_auth`, and a reuse after `max_uses`.

## Open decisions (defaults chosen; change them in review)

- **Large pages channels.** Default: re-wrap all pages in one pass. When this is too slow, re-wrap only the pages with a snapshot in an older epoch, in the order of the page tree, and the client opens the others when they arrive.
- **Default limits for invites with history.** Default: 1 use, 24 hours. An administrator can make it permanent or without a use limit, with the warning (B.0).
- **Bundles of a permanent invite with history.** Members keep sending bundles for as long as the invite lives, so the 4 MiB cap fills and the oldest epochs are dropped. A new member of an old permanent invite then gets only the recent history. Another choice: stop the commit-time bundles after 7 days, so a permanent invite gives only the history from its creation week.
- **Scope for `joined` channels.** Default: included, and marked in the dialog. Another choice: always exclude `joined` channels.
- **Bundle storage cap.** Default: 4 MiB for each invite. Older epochs are dropped first.
