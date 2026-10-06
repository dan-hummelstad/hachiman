# Invites with history, and pages for new members: plan

**Status: built** on the branch `feat/invite-history`. This document describes the built system and the reasons for it. The wire contract is normative: `docs/gateway-protocol.md` §4 ("Invite limits", Pages), §6, §11 ("Invite links"), §12.7.3, §12.11.4, §12.12, §12.16, §12.17 and §12.20. When this document and the contract differ, the contract is correct.

## Context

A new member of a guild cannot read old content until a member device that holds the keys is online. The server holds only ciphertext, so it cannot open the content for anyone (`docs/e2ee-plan.md`, contract §12). Before this work, two cases caused problems:

- **Pages.** A user who joined a pages channel saw "Waiting for a member to share this page" until a member encrypted the page again in the current epoch (`docs/pages-channels-plan.md`, "Compaction and access by new members"). Only a client that had the page open did this (`apps/hachiman/src/services/docs/DocProvider.ts`). An idle page could stay closed to a new member for a long time, also while members were online.
- **History.** A new member gets the message history of a `shared` channel only from a history bundle (§12.11.2). A committer sends it, so a member device must be online.

The work has two parts:

1. **Pages for new members** (Part A). A new reader of a pages channel can always open the current page content. Message history can stay closed. This part needs no invite change.
2. **Invites with history** (Part B). An administrator can make an invite that carries history. The new member reads it with no member online. Other invites carry no history, and the invite window says so. Part B also limits all invites (B.0).

**Constraint:** the server must not be able to read content. Thus the server must never hold a key that opens content. A "delegate key" that the server keeps and uses for the inviter is key escrow, and this plan rejects it. A member device makes every key before it is used, and the server stores only ciphertext. The one key that leaves the crypto Worker is the invite seed, and it goes only into the link (B.2).

## Terms

- **Reader:** a user with VIEW_CHANNEL on a channel.
- **Administrator:** a user with the ADMINISTRATOR permission in the current verified admin state `S` of the guild (§12.16). An administrator can read every channel. Members check the permission on their own devices, from the signed admin chain. They do not trust the REST role data for it.
- **Current state of a page:** the newest snapshot and the updates after it. The update log before the snapshot is page edit history, and this plan does not give it to new members.
- **Invite seed:** 32 random bytes in the link of an invite with history. Two key pairs come from it (B.2).
- **Invite key id:** `sign_public`, the Ed25519 public key from the seed. It identifies the invite in all crypto objects (`keyId` on a JSON wire).
- **Scope:** the groups whose history an invite with history gives (B.1).
- **Redeemer:** the user who joins with an invite with history and opens its bundles.

## Part A: pages for new members

### A.1 Decision: page content is current state, not history

`historyVisibility` controls chat history only. A reader of a pages channel can always read the current state of each page, also when the channel is `joined`. The pages plan already said this ("This works with `historyVisibility = joined` too"). Part A makes it work without a member that has the page open.

### A.2 Options

| Option | How it works | Result |
|---|---|---|
| **1. Pointer re-wrap after a join (chosen, built)** | Member devices that process a commit that adds a new user encrypt the snapshot pointer and the title of each page again in the new epoch | The page opens soon after one member processes the join commit. Small cost (see A.3) |
| 2. Page bundle per join | The committer sends one sealed bundle with all page pointers to the new device, as a history bundle | Works, but needs a new inbox kind. It helps only the one new device. Option 1 helps every later reader with the same work |
| 3. Page keys in the Welcome GroupInfo | Put the page keys in a GroupInfo extension | Rejected: the server stores GroupInfo for external commits, so the server could read the keys |
| 4. A long-lived page key per channel | Encrypt pages with a key that does not change with the epoch | Rejected: the new member still needs the key from a member, and a removed member keeps it |
| 5. Invites with history (Part B) | The epoch secrets of an invite bundle open the snapshot and title envelopes of these epochs | Opens pages with no member online, but only for invites with history. The bundles carry no page pointers |

### A.3 Pointer re-wrap

The client encrypts the snapshot blob in S3 with its own random `fileKey` (§12.20 `DocSnapshotPointer`). Only the small `doc_snapshot` envelope is in an epoch. Thus a member does not encrypt the page again. It encrypts the same pointer again in the new epoch, and it writes nothing to S3.

1. **Trigger.** The crypto Worker (`GroupService`) emits the event `usersAdded { groupId, kind, guildId, channelId, epoch, userIds, byMe }`. It emits it after a commit in a `public_set` or `channel` group that adds a leaf of a user that had no leaf before (an Add, or an external commit join). It emits it for a commit of another device (`byMe: false`), for an own batch commit (`byMe: true`), and for an own commit that it adopts after a crash. It does not emit it for an own join, a Welcome, a create, a resync or a new device of a member.
2. **Where the pass runs.** The Worker does not know channel types, and one `public_set` group covers every public channel of the guild. Thus the pass runs on the main thread, in `DocsService` and `services/docs/rewrap.ts`. It also runs when no page is open. It covers the pages channels of the group (`Channel.mlsGroupId`) in which the user has VIEW_CHANNEL and SEND_MESSAGES.
3. **Who and when.** The committer runs the pass at once, and again after `ADD_ONLY_EPOCH_GRACE_MS` + 2 s (12 s). Every other member that processes the commit runs it after a random 12 to 20 s. The first plan had a delay of 2 to 10 s. That delay is inside the epoch grace of §12.8.4 (10 s), in which a member can still post in the old epoch. When nobody is online (an external commit join), the first member that processes the commit runs the pass. One pass per group runs at a time. A pass skips the pages that are current, and Takusen accepts one re-wrap per page and epoch.
4. **What the pass does**, for each pages channel:
   - `ensureChannelGroup` gives the current group and epoch. The new route `GET /channels/:id/pages/heads` gives, for each page, `latestSeq`, the group and epoch of the title envelope, and the newest snapshot. Thus the pass needs one request per channel, not one state read per page.
   - **An open page** resyncs. Its provider does the same work itself (`DocProvider.maybeSnapshot`).
   - **Updates after the snapshot, and no snapshot or a snapshot of an older epoch or group:** the client loads the page without showing it, merges the updates, and posts a full new snapshot. An update of the old epoch can follow a current snapshot only inside the epoch grace. Thus only the second pass of the committer also loads these pages.
   - **No updates after a snapshot of an older epoch or group:** a pointer re-wrap. The client decrypts the pointer. It continues only when the result is `ok` and the pointer names the `uploadId` of the row. It encrypts the same bytes again and posts them with the same `baseSeq` and `uploadId`.
   - **A title of an older epoch or group:** the client decrypts the title, encrypts the same bytes again, and sends `PATCH /pages/:pageId { titleEnvelope, ifUpdatedAt }`. It reads the page list first, then the heads again, so a rename in between is not undone. A rename after the list read gives 409 `PageConflict`, and the client skips the page.
5. **Server rule.** `POST /pages/:pageId/snapshots` with the `baseSeq` of the newest snapshot is a re-wrap. Takusen accepts it when the `uploadId` is that of the newest snapshot and the envelope passes the envelope checks. The envelope must also be of a higher epoch, or of another group (the channel has a new group). Else it gives 409 `SnapshotConflict`, and the loser does nothing more. Takusen replaces `envelope`, `group_id`, `epoch` and `sender_device` of the row in place. It claims no upload, changes no quota and deletes nothing. It keeps the stored `media_upload_ids`, so a re-wrap cannot drop a media reference. The caller does not need to be the uploader.
6. **Title compare-and-set.** `PATCH /pages/:pageId` takes `ifUpdatedAt`. Takusen locks the page row and compares the times to the millisecond. A difference gives 409 `PageConflict`.
7. **The new member.** Until a member re-wraps a page, the page shows "Waiting for a member to share this page". A waiting page loads again after a random 10 to 30 s, then after twice the last wait, at most every 5 min. A `PAGE_UPDATE` of the page also makes it load again. When the device of the new member joins the group, the client decrypts its pending titles again. Doc envelopes do not go into the `buffered` table, so no `epochKeysAvailable` follows the join.
8. **The other members.** A re-wrapped title is of the new epoch. A member whose Worker is behind gets `pending` `epoch_ahead`. The client then catches up the channel once (`ensureChannelGroup`) and decrypts the titles again. Until then, it shows the title that it decrypted before.

**Cost.** One small envelope for each page with no updates after a stale snapshot. One full snapshot for each page with updates after a stale snapshot. One heads request per channel and pass. Takusen batches Adds (every 2 s, `TAKUSEN_MLS_BATCH_INTERVAL_MS`), so a batch of joins causes one pass. Every guild join adds a user to `public_set`, so every guild join causes a pass over all public pages channels. Every online member runs the pass. After the first pass, the other passes find the pages current and cost one heads request per channel. See "Open decisions".

**Security.**

- A re-wrap gives the new member the current state of each page, and nothing more. This is the intended access of a reader.
- The re-wrapper signs each envelope as its own sender. Thus it re-wraps only a pointer or a title that is `ok` on its device. It skips a `pending` or `failed` result.
- A removed member gets no new envelope, because the re-wrap is in an epoch without its leaf. A re-wrap does not change the blob. Thus a removed member who kept an old `fileKey` can open that blob when the server gives it the blob. This was already true before this work.
- A member who can edit can re-wrap a false pointer for the `uploadId` of the newest snapshot. The page then does not open until a member posts a new snapshot. A member who can edit can already damage a page, and the previous snapshot is the recovery path.

### A.4 What stays

- An external commit join with no member online still waits until one member comes online. No design can close this gap without a key holder. The exception is an invite with history (Part B): its epoch secrets open the pages.
- Message history follows `historyVisibility` as before.
- The page edit history before the newest snapshot stays closed to new members.

## Part B: invites with history

### B.0 Invite limits (all invites)

These rules apply to every invite, with or without history. Before this work, a user with CREATE_INSTANT_INVITE could send `maxAgeSeconds: 0` and make an invite that never expires. Also, the "Never" choice of the client sent no `maxAgeSeconds`, so Takusen made a 24-hour invite. The client now always sends `maxAgeSeconds`.

- **A user who is not an administrator makes only limited invites.** `maxAgeSeconds` must be from 1 to 86400 (24 hours). Takusen rejects 0 and larger values from this user with 403 `MissingPermissions`. The window offers 30 minutes, 1 hour and 1 day.
- **An administrator** can send 1 to 604800 (7 days), or 0. The window adds "7 days" and "Permanent". A value above 604800 gets 400 `ValidationError` for every user. The 403 check runs before the 400 check.
- **Defaults.** `maxAgeSeconds` 86400. `maxUses` 0 (no limit), at most 100. The window had a default of 7 days, which a non-administrator can no longer use. Its default is now 24 hours.
- **Only an administrator makes a permanent invite** (`maxAgeSeconds: 0`, `expiresAt: null`). A permanent invite has these requirements:
  1. **Revocable.** An administrator or a user with MANAGE_GUILD revokes it with `DELETE /invites/:code`, as before. The invite list (`GET /guilds/:id/invites`) shows permanent invites first, with the badge "Permanent", the creator and a Revoke button. A revoke stops new joins at once, because the accept locks the invite row. Members who joined already stay members.
  2. **A security warning.** Before Takusen makes the invite, the window shows a warning: "A permanent invite never expires. Anyone who gets this link, now or later, can join the guild. A link in a public place, a forwarded message or a screenshot can let unknown people in. Revoke the invite when you do not need it." For a permanent invite with history, it adds: "Anyone who gets this link can also read the history and pages of these channels: <scope>. This continues until you revoke the invite. History that someone read before the revoke stays read." The administrator must select "I understand that anyone with this link can join until I revoke it." The REST body then gets `acknowledgedPermanent: true`. Takusen rejects a permanent invite without it with 400 `ValidationError`, so another client cannot skip the warning.
- **No race with a demotion.** Takusen makes a permanent invite and an invite with history in one transaction. The transaction locks the guild row and the membership row of the creator (`FOR SHARE`) and checks ADMINISTRATOR again.
- **A creator who loses ADMINISTRATOR.** Five changes can remove ADMINISTRATOR or the membership of a creator: a role permissions edit, a role delete, a member-role edit that removes a role, a kick and a leave. Each of them revokes the permanent invites and the invites with history whose creator lost ADMINISTRATOR or left the guild. This occurs in the transaction of the change, and the revoke deletes the bundles. Takusen checks every creator in the guild, because one role change can demote many users. Thus the first such change in a guild also revokes the permanent invites that users without ADMINISTRATOR made before these limits existed.
- **New gateway event** `INVITE_DELETE { guildId, code, inviteId }` → guild (§6). Takusen publishes it after the first revoke of an invite: by `DELETE /invites/:code`, or by the loss of ADMINISTRATOR. The invite list removes the row. The crypto Worker marks the invite revoked (B.1).
- **New fields.** `Invite` gets `id` (the bundle routes name the invite by it) and `hasHistory`. `InvitePreview` gets `hasHistory`. `expiresAt: null` still means permanent.
- **Code:** `apps/takusen/src/lib/invite-limits.ts`, `apps/takusen/src/lib/invites.ts` (`createAdminInvite`), and the routes of the role, member and invite changes. The window: `components/settings/permanent-invite-confirm.tsx`, `components/settings/invites.ts`.

### B.1 Rules

- **Only an administrator can make an invite with history.** The invite window shows the switch "Include history" only to an administrator, and it is off by default. Takusen checks ADMINISTRATOR from the REST roles (403 `MissingPermissions`). Members check it again from the signed admin chain (B.3).
- **Other invites carry no history.** When the switch is off, the window says: "This invite does not include message history. The new member sees pages, and the history of the channels that they can see, only when a member shares it."
- **Scope.** An invite with history covers the channels that the invitee can see when they join. Invites do not give roles. Thus the scope is the text and pages channels where @everyone has VIEW_CHANNEL. The window shows the scope from the REST roles and marks each `joined` channel. The crypto Worker signs only the channels where @everyone has VIEW_CHANNEL in `S` (at most 500). Thus the signed list can be shorter than the list in the window. A later role or overwrite change can only remove channels from the scope.
- **The scope is mostly the `public_set` group.** A channel that @everyone can view, with no overwrite that hides it from a role, is public. All public channels share one `public_set` group (§12.6). The `public_set` group is in the scope of every invite with history of its guild, as a whole. A `channel` group is in the scope only when its channel is in the signed list and @everyone can still view it in `S`. That is a channel that @everyone can view but that an overwrite hides from a role. A `dm` group is never in the scope. Each device decides the scope from its own MLS group descriptors, never from REST data.
- **Limits.** "Include history" sets 1 use. The expiry has the default of every invite, 24 hours. The administrator can change both: up to 7 days or permanent (with the warning of B.0), and up to 100 uses or no limit. The record holds the same values: `expires_at_ms = 0` means permanent, and `max_uses = 0` means no limit. Takusen requires that the record values agree with the request.
- **The link shows once.** Only the creator window sees the seed. The invite list shows the badge "History" and has no Copy button for an invite with history.
- **Revoke reaches the members.** The shared UI gives `INVITE_DELETE` to the crypto Worker. A device that has a row for the invite marks it revoked and deletes the seed of a redeemer. It then sends no more bundles for the invite, and it rejects later `InviteAuth` joins of the invite. A device that was offline gets the invite list from `GET /guilds/:id/invite-records`, which lists only active invites. Takusen also refuses a bundle for an invite that is not active.

### B.2 The invite key

The crypto Worker of the administrator makes a 32-byte random `invite_seed` and derives two key pairs from it:

```
hpke_priv = HKDF-SHA256(salt = "", IKM = invite_seed, info = "hachiman invite hpke v1", 32)   → X25519: hpke_public = X25519(hpke_priv)
sign_priv = HKDF-SHA256(salt = "", IKM = invite_seed, info = "hachiman invite sign v1", 32)   → the Ed25519 seed of the key pair: sign_public
```

- The derivation does not use the RFC 9180 `DeriveKeyPair`. Contract §12.11.4 has a test vector.
- `sign_public` is the invite key id. The record has no invite code, because Takusen makes the code after the creator signs the record. The first plan had a `code_hash` in the record and the bundles. The key id replaces it.
- The link is `https://<Takusen issuer origin>/invite/<code>#k=<base64url(invite_seed)>`: 43 characters, no padding. A browser does not send the part after `#` to the server.
- **The Takusen page.** A clicked link opens the Takusen page `/invite/<code>` in a browser, for both hosts. A script of that page reads the fragment. It adds a well-formed `#k=` to the "Open" buttons (the web client and `takusen://invite/<code>`), and it removes the fragment from the address bar with `history.replaceState` (`src/lib/invite-fragment.ts`, `open-invite-buttons.tsx`).
- **The hosts.** `parseInviteLink` (`apps/hachiman/src/lib/invite-link.ts`) reads all link forms. It fails closed: a fragment other than `k=` and 43 canonical base64url characters gives null, so a damaged link cannot join without the history by accident. The browser host reads the link at start-up and replaces the URL with `/` (`launch-url.ts`). The Electron main process checks the deep link and sends it, rebuilt from the checked parts, on the IPC channel `hachiman:invite-link` (`deep-link-route.ts`). The seam method is now `onInviteLink`.
- **Custody of the seed.** The seed crosses the UI thread as opaque base64url text, as the recovery key does. This is the one exception to "no key outside the Worker" (§12.17, CLAUDE.md). `prepareHistoryInvite` returns it once. The creator window keeps it in component state, and the creator Worker does not store it. The redeemer UI keeps it in an in-memory map (`InviteService`) until the redemption. It never goes into a Zustand store or `localStorage`. The browser host keeps it in `sessionStorage` (`hachiman-invite-key:<code>`, this tab only) only across the sign-in redirect. The next start-up deletes an entry that no callback used. The redeemer Worker keeps the seed in its encrypted store for `INVITE_AUTH_WINDOW_MS` (24 h) after the redemption, then deletes it.

### B.3 The invite record

The creator device signs a record. The client sends it as `record` in the body of `POST /guilds/:id/invites`:

```
struct {
  uint8  version = 1;
  opaque guild_id[16];
  opaque hpke_public[32];          // X25519
  opaque sign_public[32];          // Ed25519, the invite key id
  opaque channel_ids<V>;           // the scope: 16 bytes each, strictly ascending, 0 to 500
  uint64 admin_chain_seq;          // the seq of the admin state that the creator used (§12.16)
  uint64 expires_at_ms;            // 0 = permanent
  uint32 max_uses;                 // 0 = no limit
  opaque creator_user_id[16];
  opaque creator_device_id[16];
} InviteRecord;

struct {
  opaque record<V>;                // encode(InviteRecord)
  opaque signature<V>;             // SignWithLabel(creator device MLS signature key, "InviteRecord", record)
} SignedInviteRecord;
```

Changes from the first plan:

- No `code_hash` (B.2).
- `creator_user_id` is new: a device certificate lookup needs the user id.
- The signature is by the MLS signature key of the creator device, which its device certificate names.
- `channel_ids` are in the unsigned byte order of the ids. A decoder rejects ids out of order and duplicate ids.

**Takusen** checks the record at `POST /guilds/:id/invites`. It needs ADMINISTRATOR and an active `X-Hachiman-Device`. It verifies the record with `DsModule.verifyInviteRecord` under the certificate of that device. Then it requires all of these, else 400 `ValidationError`:

- `guild_id`, `creator_user_id` and `creator_device_id` are the guild, the caller and the device of the request.
- `max_uses` is `maxUses`. `expires_at_ms` is 0 for a permanent invite, else within 5 minutes of now + `maxAgeSeconds`.
- `channel_ids` has at most 500 ids, and each id is a channel of the guild.
- No other invite has the key id.

Takusen stores `record` and `key_id`. It does not check the admin state of the record: members do.

**A member device accepts a record** only when all of these are true (§12.16):

- The record is for the guild of the check.
- The device has a verified admin state `S` for the guild (no genesis: fail closed), and `admin_chain_seq` ≤ `S.seq`.
- The creator has ADMINISTRATOR in `S`, and the creator is a guild member.
- The certificate of the creator device has a valid chain (§12.4, with key transparency on first contact). The device is not revoked, and the trust of the creator is not `changed`. The signature verifies, and the certificate names the creator ids of the record.
- `expires_at_ms` is 0 or in the future, and the device did not get a revoke of the invite. The redeemer accepts a record that expired less than 1 h ago, because Takusen gives the bundles for 1 h after the join. A member that checks an `InviteAuth` join does not check the expiry, because Takusen checked it at the upload.

The device checks against `S` only. The first plan also checked the admin state "at `admin_chain_seq`". The Worker keeps only the current state, and that check adds nothing: a current administrator can sign a new record at any time. A later change can only make the scope smaller. A scope channel counts only while @everyone has VIEW_CHANNEL on it in `S` (`AdminPermissionModel.everyoneChannelPermissions`: the @everyone role and the @everyone overwrite only). The device caches the signature check per key id and `S.seq`. It runs the other checks each time.

### B.4 Invite bundles

An invite bundle is a sealed set of epoch secrets for one invite and one group:

```
struct {
  uint8  version = 1;
  opaque sign_public[32];          // the invite key id
  opaque group_id<V>;
  HistoryKey keys<V>;              // §12.11.2: S_e, strictly ascending epochs, 1 to 4096 keys
  opaque sender_user_id[16];
  opaque sender_device_id[16];
} InviteBundleTBS;

struct {
  opaque tbs<V>;                   // encode(InviteBundleTBS)
  opaque signature<V>;             // SignWithLabel(sender device MLS signature key, "InviteBundle", tbs)
} InviteBundleContent;

struct {
  uint8  version = 1;
  opaque enc[32];
  opaque ciphertext<V>;            // HPKE base mode, §12.3 suite: Seal(pkR = hpke_public, info = "hachiman invite bundle v1",
                                   //   aad = sign_public ‖ group_id, pt = encode(InviteBundleContent))
} InviteBundle;
```

- The AAD and the signed TBS bind a bundle to one invite and one group.
- **No page pointers.** The first plan put the page pointers in the bundles. The client encrypts the snapshot and title envelopes under epoch secrets, so the epoch secrets of the bundle open them. Part A re-wraps the pages after the join.
- One bundle is at most 640 KiB (`INVITE_BUNDLE_MAX_BYTES`).

Who sends bundles (`pkgs/hachiman-crypto/src/invites/service.ts`):

1. **At creation.** After `POST /guilds/:id/invites`, the creator device sends one bundle for each scope group that it holds. Each bundle has the stored epoch secrets of the group, at most `HISTORY_BUNDLE_MAX_EPOCHS` (the newest). When a post fails, `sendInviteBundles` rejects, and the window revokes the invite. When the device holds no scope group (for example, the channels have no messages yet), it sends nothing. The window then shows a warning: the link gives only the history that members send at their commits.
2. **After each own commit** in a scope group. An own commit is a batch commit, a commit before a send, an own external commit (a join or a resync), or a commit that the device adopts after a crash. The device gets the active invites of the guild (`GET /guilds/:id/invite-records`, kept for 60 s, deleted by `INVITE_DELETE`). For each one, it sends the secret of the new epoch. The bundle also has the stored secrets of the epochs between the newest bundled epoch and the new epoch. The newest bundled epoch is the higher of two values: the `bundled` hint of the list, and the newest epoch that this device sent. Thus a bundle fills the epochs of a committer that sent no bundle (an old client, or a member whose list predates the invite).
3. The device always sends the new epoch, also when the `bundled` hint has it. Any reader can raise the hint with a bundle that does not open. The device does not send an epoch again after it sent it.
4. Before each bundle, the device checks the record (B.3) and decides the scope from its own descriptor. A failure for one invite does not stop the others.
5. **Timeline.** When a device accepts a record for the first time, it adds the event `invite_with_history` to the membership timeline of each scope group that it holds. The UI shows "<creator> made an invite that includes history. A person who has its link can read the history here."

The first plan also had the sender of each new snapshot send a bundle. That step is gone with the page pointers.

**Storage.** Takusen stores the bundles in the new table `invite_bundles` (migration `0001_invite_history`). A row has the invite id, the group id, the epoch, the sender device, the sender user, the blob and its size. `POST /invite-records/:inviteId/bundles` accepts a bundle only when all of these are true:

- The caller reads the group (else 404 `UnknownGroup`), and `epoch` is not above the epoch of the group (else 400 `ValidationError`).
- The group is of the guild of the invite, and the invite is active and has a record (else 404 `UnknownInvite`).
- The group is in the scope of the stored record: the `public_set` group, or a `channel` group whose channel is in `channel_ids` (else 400 `ValidationError`).

Takusen locks the invite row for the insert. Then it applies two caps, and the oldest bundles go first:

- One sender user keeps at most 1 MiB of bundles per invite, for all its devices together. The creator has no such cap. Without it, one member could push the creation bundles out of the invite cap.
- One invite keeps at most 4 MiB of bundles (`INVITE_BUNDLES_MAX_BYTES`).

The rate limit is 120 posts/min per device and 360/min per user.

**Lifetime.**

- The revoke deletes the bundles in its transaction.
- The redeemer gets the bundles only during 1 h after its guild join with the invite (`INVITE_BUNDLE_FETCH_WINDOW_MS`). The first plan deleted the bundles at the last use. But the last use is the join of the redeemer, and the redeemer needs the bundles after it.
- The daily DS sweep deletes the bundles of revoked invites, and of invites whose expiry or last use is more than 1 h in the past.

### B.5 Redeeming the invite

The order changed from the first plan. The client cannot check the record before the join: before the join, the new user shares no guild with the creator. Thus it cannot get the keys of the creator (`GET /users/:id/keys`) or the admin chain of the guild.

1. **Read the link.** The host reads the seed from the fragment and removes the fragment from the address bar (B.2). The shared UI keeps the seed in memory. The join window says "This invite includes history" when the preview has `hasHistory` and the link has the seed. Without the seed, it tells the user to open the full link. When the crypto Worker cannot start in this window (for example `LockHeld`: Hachiman runs in another tab), the window shows a warning. The user must then select "Join without the history" before the join.
2. **Join the guild** with `POST /invites/:code`, as before. The membership row names the invite (`guild_members.invite_id`). The accept of the last use sets `invites.exhausted_at`.
3. **Start the redemption.** The UI calls `redeemInvite({ code, linkSecret })` when the Worker is ready and the client cache has this user in the guild members. It tries at once, when the Worker becomes ready, and on `READY` and `GUILD_CREATE`. After a network error, a 5xx or a 429, it tries again after 5 s. Each later wait is twice the last, up to 5 min, inside the 1-hour window. Another failure loses only the history: the user stays a member, and a security notice tells the user.
4. **Check the record.** The Worker gets `GET /invites/:code/bundles`, which returns the stored record and the bundles. It derives the two key pairs from the seed. It accepts the record only when its `sign_public` and `hpke_public` are the derived keys, and the record passes the checks of B.3. Thus the seed binds the record and the bundles: a server cannot give another record. The new user has no pinned keys for the creator. Thus this is first contact, and the client trusts the keys through key transparency (§12.14).
5. **Open the bundles.** For each bundle, the Worker requires that the group is in the scope. It decides this from the group id, and from the descriptor of a group that it holds. It opens the HPKE ciphertext with the AAD of the invite and the group. It requires that the TBS names the derived key id and the group of the AAD. The certificate of the sender device must have a valid chain, and the device must not be revoked. The sender user must be a guild member, and its trust must not be `changed`. The signature must verify. The Worker drops a bundle that fails a check, and keeps the others.
6. **Limit the keys.** Any member can sign a bundle with wrong keys. Thus the Worker keeps only the epochs up to the bundle `epoch` (Takusen kept it at or below the group epoch). In a group that it holds, it keeps only the epochs below its current epoch. When two bundles give a secret for one epoch, the bundle of the creator device wins, then the oldest bundle.
7. **Import.** `importHistoryKeys` (source `bundle`) never replaces a stored secret. Messages that decrypt with these keys get `membershipVerified = false`, as with a history bundle. A secret that a device derives from its own MLS state replaces an imported secret that differs (§12.11.1).
8. **Later bundles.** At the redemption, some epochs can have no bundle yet: for example, the epoch of the commit that adds the redeemer. Thus the Worker gets the bundles again, with the same checks. It does this 10 s after the redemption and 10 s after each own MLS join of a scope group. It does this only during 1 h after the redemption, while it keeps the seed, and while the invite is not revoked.
9. **Join the groups.**
   - **`public_set`:** as before. Any reader joins it, also by external commit when no member is online.
   - **`channel`:** by external commit with an `InviteAuth`, with no join request:

     ```
     struct {
       uint8  version = 1;
       opaque signed_record<V>;     // SignedInviteRecord
       opaque signature<V>;         // SignWithLabel(invite sign key, "InviteAuth",
                                    //   encode(struct { opaque group_id<V>; opaque leaf_signature_key<V>; }))
     } InviteAuth;
     ```

     The `InviteAuth` goes in the MLS `authenticated_data` of the external commit, not in a leaf extension as the first plan said. The FramedContent signature of the new leaf covers it, so ts-mls on the members and `DsModule.checkCommit` on Takusen both see it. Nothing stays in the tree. The signature binds the group and the leaf key, and only a holder of the seed can make it.
   - **Takusen** accepts the external commit of a user without a leaf into a `channel` group only when all of these are true (§12.7.3 check 9). Else it gives 403 `IllegalAdd`.
     - The `InviteAuth` verifies for the group and the key of the new leaf.
     - The invite with that key id is of the guild of the group, and its stored record is byte-equal to `signed_record`.
     - The invite is not revoked and not expired.
     - `channel_ids` has the channel of the group.
     - The caller joined the guild with this invite during the last 24 h (`INVITE_AUTH_WINDOW_MS`).
   - **Members** check the `InviteAuth` before they apply the commit: the signature, the record (B.3, without the expiry), the revoke mark, the scope, and that the joiner is a reader. A failed fetch during the check is not a verdict: the member processes the commit again at the next catch-up.
   - The policy table is in §12.7.3, not in §12.7.5 as the first plan said. The row "External commit (join)" for `channel` now also allows a reader device with a valid `InviteAuth`. §12.7.5 (the batch scheduler) got a note: a redeemer does not wait for a `channel` group of the scope.
   - **The redeemer** makes the `InviteAuth` in `sync()` and `ensureChannelGroup`, while it keeps the seed and the record passes the checks of B.3. When it cannot make the `InviteAuth`, or Takusen refuses the commit, it posts a join request. After a 403 `IllegalAdd`, it does not try the `InviteAuth` for that group again until the Worker starts again.
10. **Pages.** The imported epoch secrets open the snapshot and title envelopes of these epochs, with no member online. Part A re-wraps the pages after the join.

### B.6 Security implications

**What the server cannot do**

- **Read content.** The server stores the record and the bundles, but it does not have the seed.
- **Make an invite with history that members accept.** The record needs a signature from the device of an administrator. Members check the creator against their own verified admin state, not against REST roles.
- **Swap the record, or move a bundle.** The seed binds the record through the key id. The AAD and the signed TBS bind each bundle to the invite and the group.
- **Make the signed scope larger.** The scope is in the signed record. Each member decides the scope from its own group descriptors. The redeemer checks the scope of each bundle again.
- **Get its own account into a `channel` group in a way that members accept.** The external commit needs an `InviteAuth`, which only the seed can sign. A hostile Takusen can still accept a join without it. Then each member rejects the commit and raises a fork alert, but the joiner stays in the tree. This is detection only, as for every other illegal Add by a hostile server (§12.7.3).

**What changes, and the risks**

- **The link is a bearer secret.** Anyone who has the full link gets the history in the scope. The link can leak through a forwarded message, a screenshot, a link in a public place, browser history or a link preview service. This is the largest risk. The mitigations:
  - The option is off by default, and its defaults are 1 use and 24 hours.
  - The window shows a warning with the scope, and a permanent invite needs an acknowledgment.
  - An administrator can revoke the invite.
  - Only the user who joined with the invite gets the bundles, and only during 1 h after the join.
  - The revoke deletes the bundles. The daily sweep deletes them when the expiry or the last use is more than 1 h ago.

  A revoke does not help after a use: history that was read stays read.
- **A permanent invite with history makes this risk unlimited in time.** The link opens the scope until someone revokes it. It also opens content written after creation, because members keep sending bundles. A leak that nobody notices gives continuous access to the scope. The only control is a revoke. Thus B.0 requires the warning and the acknowledgment, and the invite list marks permanent invites and invites with history. The timeline records each invite with history, permanent or not. A server that hides a revoke from members (no `INVITE_DELETE`) makes members send bundles for longer. This gives nothing to the server, which cannot open them, but it extends access for a person who has the link.
- **A permanent invite without history** gives no content. It lets anyone with the link join, and then read what @everyone can read from that point. This is the same as a Discord permanent invite.
- **The `public_set` group is in the scope as a whole.** Its epoch secrets open every channel of that group in these epochs. This includes a channel that became public after the creation of the invite. The signed `channel_ids` limit only the `channel` groups.
- **The Takusen page reads the seed.** A clicked link opens the Takusen page `/invite/<code>` in a browser, and Takusen serves the script that reads the fragment. Thus a hostile Takusen can read the seed in both hosts. The first plan said that the Electron host does not have this risk. That is true only for a link that the user pastes into the Electron app. The browser host has the general limit too: a hostile server can send hostile JavaScript, and this applies to all keys in the browser.
- **The seed leaves the Worker.** It is in the component state of the creator window and in the memory of the redeemer UI. During a browser sign-in redirect, it is in `sessionStorage` (B.2). The redeemer Worker keeps it in its encrypted store for 24 h, in a row that also keeps the code. Thus a leaked store gives the full link in that time. This gives access only while the invite is active and has uses left.
- **The server enforces single use.** A hostile server can give the bundles to more people than `max_uses` allows. Each of them also needs the seed. Thus this risk is only for people who already have the link.
- **Wrong keys from a member.** Any member reads `public_set` and can sign a bundle with wrong keys. A reader of a channel in the scope can do the same for its group. The redeemer limits the keys (B.5 step 6), but a member can still give a wrong secret for an epoch that has no earlier bundle. Examples are the epoch of a committer that did not post yet, of an old client, or of a bundle that a cap deleted. A server that gives the bundles in another order has the same effect. The effects:
  - The redeemer cannot read the messages of that epoch. Each failed decrypt counts toward the fork alert, so a member can cause false fork alerts on the redeemer.
  - The redeemer shares an imported secret as its own: in its backups, in the history keys for its own new devices, in its history bundles and in the bundles of later invites. An import never replaces a stored secret, so a later right secret does not repair a device that got the wrong one first.
  - The secret from the MLS state replaces a wrong one in each epoch that the redeemer enters. Thus its sends and its later epochs stay correct.
- **Members can push out the creation bundles.** The cap of 1 MiB per sender user stops one member. Four members together can always push the bundles of the creator out of the 4 MiB cap, and fewer can when the creation bundles are large. The result is less history, not access.
- **An administrator and a server that act together** can give the redeemer wrong secrets for a `channel` group of another guild that the redeemer does not hold yet. A channel id does not name its guild, and Takusen checks that the record channels are of its guild. When the redeemer joins that group later, an import never replaces these secrets.
- **History for more people.** A `joined` channel in the scope also gives its history through the invite. Thus the administrator makes this choice for the channels of the scope. The window lists the channels of the scope and marks each `joined` channel.
- **Forward secrecy.** An epoch secret in a bundle opens every message of that epoch. When an attacker gets the seed and the stored bundles before Takusen deletes them, the attacker gets this history. This is the same as the risk of the recovery key backup, but limited to the scope and to the life of the invite.
- **A removed or demoted administrator.** Members check the record against the current admin state before each bundle, at the redemption, and before each `InviteAuth` join. When the creator loses ADMINISTRATOR, the invite stops: members send no new bundles and reject its joins. Takusen also revokes the permanent invites and the invites with history of that user, and deletes their bundles. Bundles that a redeemer opened already stay read.
- **The revoke reaches only the devices that know the invite.** A device with a row for the invite marks it revoked. A device without a row relies on Takusen, which lists the invite no more. A member that got the revoke after the upload of a valid `InviteAuth` join rejects that join and raises a fork alert.
- **Older clients.** A client without the `InviteAuth` rule rejects a valid invite join. It raises a fork alert (`commit_rejected`) and resyncs its own leaf, and the joiner stays in the tree. To stop these alerts, set `GATEWAY_MIN_CLIENT_VERSION` to the first version with the rule.
- **A compromised administrator device** can make invites with history and give them to an attacker. This is no new risk: that device can already read all channels. The timeline and the invite list show each invite with history, with its creator.
- **Metadata.** The server learns which invites carry history, the scope, the creator, the limits, which members send bundles for which group and epoch, and when the redeemer gets the bundles.
- **Trust of the new member in the record.** The new user has no earlier contact with the administrator. The client checks the record after the join, through key transparency. When KT is off on the deployment, the server could give a false record and false bundles. The result is wrong content shown to the new user, not access to real content.

**Not in this plan:** invites that give roles (then the scope could include private channels), and history for a user who joins in another way (for example, when a role gives them a channel).

## Phases

All five phases are complete on `feat/invite-history`. Phases 1 and 2, and the crypto core of phases 3 and 4, came in one commit. The other phases came in this order: the Takusen storage, the Worker invite service, the UI and hosts, then `InviteAuth`.

1. **Pointer re-wrap (Part A).** The `usersAdded` event in `GroupService`, the pass in `services/docs/rewrap.ts`, the pointer re-wrap in `DocProvider`, the title catch-up (`services/docs/titles.ts`), the snapshot re-wrap rule, `GET /channels/:id/pages/heads`, and `ifUpdatedAt` with 409 `PageConflict`. Contract: §1 `PageHead`, §3 `doc_snapshots`, §4 Pages, §12.19, §12.20.
2. **Invite limits (B.0).** The 24-hour limit for users without ADMINISTRATOR, permanent invites for administrators with the warning and `acknowledgedPermanent`, the invite list, the revoke on loss of ADMINISTRATOR, and `INVITE_DELETE`. Contract: §4 "Invite limits", §6.
3. **Invite record and window.** The seed, the key derivation, the record and its checks (`DsModule.verifyInviteRecord`, `everyoneChannelPermissions`), the "Include history" switch with the scope, the text for invites without history, the link with the seed, and its custody. Contract: §1, §3 `invites`, §4, §11, §12.2, §12.3, §12.11.4, §12.16, §12.17.
4. **Invite bundles.** Bundles at creation and after each own commit, the table `invite_bundles` with its caps and sweep, the record list for members, and the redemption with its checks and later fetches. Contract: §3, §12.11.1, §12.11.4, §12.12, §12.13.
5. **Invite authorization for `channel` groups.** `InviteAuth` in `authenticated_data`, the Takusen rule (§12.7.3 check 9), the member check, and the join of the redeemer. Contract: §12.7.3, §12.7.5, §12.7.8, §12.18.

## Critical files

- `docs/gateway-protocol.md`: §1 (`Invite`, `InvitePreview`, `PageHead`), §3 (`guild_members.invite_id`, `invites`, `invite_bundles`, `doc_snapshots`), §4 ("Invite limits", invites, Pages), §6 (`INVITE_DELETE`), §10, §11 ("Invite links", `onInviteLink`), §12.2, §12.3, §12.7.3, §12.7.5, §12.7.8, §12.7.9, §12.11.1, §12.11.4, §12.12, §12.13, §12.16, §12.17, §12.18, §12.19, §12.20.
- `pkgs/hachiman-crypto/src/invites/`: `codec.ts`, `keys.ts`, `record.ts` (the structs, the keys, the seal and the signatures) and `service.ts` (the record checks, the bundles, the redemption, the `InviteAuth`).
- `pkgs/hachiman-crypto/src/api.ts`, `src/constants.ts`: the invite methods, `usersAdded`, the limits and the labels.
- `pkgs/hachiman-crypto/src/mls/service.ts`, `policy.ts`, `index.ts`, `ds.ts`: `usersAdded`, `onOwnCommit`, `onJoin`, the `InviteAuth` check and join, `authenticated_data`, `verifyInviteRecord`, `parseInviteRecord` and `verifyInviteAuth`. `src/worker/permissions.ts`: `everyoneChannelPermissions`. `src/store/index.ts`: the store table `invites` (database version 2).
- `apps/takusen/src/lib/invite-limits.ts`, `src/lib/invite-history.ts` (with `invite-history.in-memory.ts` and `invite-history.conformance.ts`), `src/lib/invites.ts`, `src/lib/invite-fragment.ts`.
- `apps/takusen/src/app/api/v1/`: `guilds/[id]/invites`, `guilds/[id]/invite-records`, `invite-records/[inviteId]/bundles`, `invites/[code]`, `invites/[code]/bundles`, `channels/[id]/pages/heads`, `pages/[pageId]`, and the role and member routes. `apps/takusen/src/app/invite/[code]/open-invite-buttons.tsx`.
- `apps/takusen/src/lib/mls/commits.ts` and `MlsRepo` (`getInviteByKeyId`, `inviteJoinedBy`, both implementations). `apps/takusen/src/lib/docs/` and `DocsRepo` (`rewrapSnapshot`, `newestSnapshots`, both implementations). `apps/takusen/src/grpc/mls-scheduler.ts`: the bundle sweep.
- `apps/takusen/src/db/schema.ts`, `apps/takusen/drizzle/0001_invite_history.sql`.
- `apps/hachiman/src/services/docs/`: `rewrap.ts`, `titles.ts`, `DocsService.ts`, `DocProvider.ts`.
- `apps/hachiman/src/services/InviteService.ts`, `src/lib/invite-link.ts`, `src/components/invite-dialog.tsx`, `src/components/settings/invite-history-option.tsx`, `permanent-invite-confirm.tsx`, `invites.ts`, `src/components/guild-settings-invites.tsx`, `src/components/join-server-modal.tsx`.
- Hosts: `apps/hachiman-browser/src/platforms/browser/launch-url.ts`, `apps/hachiman-electron/src/main/deep-link-route.ts`, `src/shared/ipc.ts`.

## Verification

**Automated tests.** These suites pass on the branch. The `*.pg.test.ts` files run only with `TAKUSEN_PG_TEST_URL` (a Postgres database).

- **Re-wrap:** `rewrap.test.ts` (the timing, the pass, the pointer and title re-wraps, 409), `DocProvider.test.ts` (the idle page re-wraps its pointer, the slow retry), `DocsService.test.ts`, `titles.test.ts`, `mls/service.spec.ts` (`usersAdded`), and the Takusen `lib/docs/service.test.ts` and repo conformance (the re-wrap rule, the heads, `PageConflict`).
- **Invite limits:** `invite-limits.test.ts` (403 for `maxAgeSeconds` 0 or above 86400 from a user without ADMINISTRATOR, 400 without `acknowledgedPermanent`, the creators that lost ADMINISTRATOR), `invite-limits.pg.test.ts` (the revoke on demotion, the permanent invite and the record in one transaction), and the UI `invites.test.ts`.
- **Record and bundles:** `invites/codec.spec.ts`, `codec.fuzz.spec.ts`, `keys.spec.ts` (the test vector, another seed, the group and the key id in the AAD), `record.spec.ts`, `ds.spec.ts`, and the Takusen `invite-history.test.ts` with its conformance on both stores.
- **The invite service** (`invites/service.spec.ts`, with `FakeMlsDs`): the creation bundles open for the redeemer, a commit bundle carries the new epoch also when the `bundled` hint has it, and `membershipVerified` is false. Rejected: a demoted creator, a changed record, a wrong group, a foreign sender, a revoked invite.
- **InviteAuth:** `mls.spec.ts` (policy), `mls/service.spec.ts` (an end-to-end join), `smoke.spec.ts` (`authenticated_data` survives `joinGroupExternal`), and the Takusen `commits.test.ts`: a valid join, an `InviteAuth` for another leaf key, a record that differs, a channel outside the record, a revoked or expired invite, a user who did not join with the invite, the end of the window, and a `dm` group.
- **Links and redemption:** `invite-link.test.ts`, `InviteService.test.ts`, `invite-fragment.test.ts`, `deep-link-route.test.mts`, `launch-url.test.mts`.

**Manual checks** with a real backend and two clients (the automated suites do not cover them):

- **Re-wrap:** a member adds a user to a private pages channel and closes the app. The new user opens every page, also pages that nobody opened. A page with updates after its snapshot also opens.
- **External commit join:** a user joins a public pages channel when no member is online. The page waits. When one member comes online, the page opens without the member opening it.
- **Invite with history:** an administrator makes an invite and goes offline. A new user opens the link, signs in, joins, and reads the history and pages of the channels in the scope. The history includes the content written after creation.
- **Rules:** a user without ADMINISTRATOR does not see "Include history", and the window shows the text for an invite without history.
- **Invite limits:** an administrator sees the warning for a permanent invite. A revoked permanent invite fails to join at once. When the creator loses ADMINISTRATOR, their permanent invites and invites with history disappear from the list.
- **Hosts:** a clicked link and a pasted link with `#k=` in the browser host and in the Electron app. The address bar of the Takusen page and of the web client shows no fragment after the load.

## Open decisions (built defaults: change them in review)

- **Large pages channels.** Default: one pass covers all pages of the pages channels of the group, and it skips the pages that are current. Each guild join causes a pass over all public pages channels on every online member. Another choice: a member that did not commit runs the pass only after an external commit join, where no member committed. A page then waits when the committer goes offline during its pass.
- **Default limits for invites with history.** Default: 1 use, 24 hours. An administrator can make it permanent (with the warning and the acknowledgment of B.0) or remove the use limit (with the history warning only). Another choice: an acknowledgment for an invite with history and no use limit too.
- **Bundles of a permanent invite with history.** Members keep sending bundles for as long as the invite lives. The caps drop the oldest bundles, so a new member of an old permanent invite gets the creation bundles and the recent history. Another choice: stop the commit-time bundles after 7 days, so a permanent invite gives only the history from its creation week.
- **Scope for `joined` channels.** Default: included, and marked in the window. Another choice: always exclude `joined` channels.
- **Bundle storage cap.** Default: 4 MiB for each invite, and 1 MiB for each sender user except the creator. The oldest bundles go first.
- **Wrong keys from members.** Default: the redeemer accepts the bundles of every member, with the limits of B.5 step 6. Another choice: accept only the bundles of the creator device. That stops the risk, but it loses the history after the creation.
- **The Takusen page in the link.** Default: the link opens the Takusen page, which forwards the seed. Another choice: a link to the web client, so that a clicked link does not load a Takusen page. The browser host still has its general limit.
- **Older clients.** Set `GATEWAY_MIN_CLIENT_VERSION` to the first version with the `InviteAuth` rule when the first invite with history has a `channel` group in its scope. Until then, older clients raise fork alerts on valid invite joins.
