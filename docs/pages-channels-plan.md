# Pages channels ("mini-Notion"): plan

## Context

Users want a guild channel type for collaborative work on markdown documents. The channel works like a Claude artifact: chat stays in the center, and the document shows on the right side in place of the member list. A drag handle sets the width of the document panel.

- Any member with access can edit the document at the same time as other members. Edits show immediately.
- Redis carries the live updates and the presence (who is in the page, cursors, selections).
- One channel holds many pages in a tree. A page can link to another page, as in Notion.
- The editor is an off-the-shelf markdown editor with an MIT license.

**Constraint from the E2EE design:** every channel type uses E2EE, and there is no plaintext mode (CLAUDE.md, contract §12). Takusen, Redis and the gateway must see only ciphertext of page content, titles and cursors. Thus the server cannot merge edits. The merge happens on the clients with a CRDT, and the server stores and relays encrypted CRDT updates.

## Name

The name is **Pages channel** (type id `pages`). It names the unit that the user makes. The sidebar row reads "📄 design-pages". The UI calls the content of one page "the page", and the right panel "the pages panel".

## Decisions

### 1. Editor: Milkdown Crepe + Yjs

- **Editor:** `@milkdown/crepe`, MIT. It is a markdown-native WYSIWYG editor on ProseMirror and remark. The UX is like Notion: slash menu, block handle, tables, code blocks (CodeMirror, MIT), task lists and link tooltips. Markdown is its source format, and `getMarkdown()` exports the page.
- **Collaboration:** `@milkdown/plugin-collab` (MIT) binds a Yjs `Doc` and an awareness object to the editor (`collabServiceCtx.bindDoc(doc).setAwareness(aw).connect()`). It uses `y-prosemirror` internally.
- **CRDT:** `yjs` and `y-protocols` (MIT). Edits merge in any order, so the server does not need to order updates.
- **Transport:** our own small Yjs provider (no `y-websocket`). It encrypts each update and sends it through Takusen and the gateway.
- Why not the others:
  - TipTap: its markdown support and its collaboration-cursor extensions are not in the free core.
  - BlockNote: MPL-2.0 license.
  - Lexical: no markdown-first collaboration path.
- **Risk:** Crepe must accept the collab plugin through `crepe.editor.use(collab)` before `create()`. Phase 4 starts with a spike to confirm this. If it fails, use `@milkdown/kit` with the same plugin set that Crepe uses.

### 2. Data model: a page tree, an encrypted update log, encrypted snapshots in S3

Plan for the worst case: large pages, and images, video and files in pages. Thus the bytes of every snapshot and every media file go to S3, and Postgres holds only small rows and pointers. Takusen stores three new tables (contract §3), and pages also use the existing `uploads` table:

- `doc_pages`: `id`, `channel_id`, `parent_id` (null for a root page), `position`, `title_envelope` (bytea, encrypted title), `created_by`, `created_at`, `updated_at`.
  - The server sees only the tree shape and the timestamps. This is metadata, like message timing.
  - The title is a separate small envelope, so that the page tree decrypts without the page content.
- `doc_updates`: `page_id`, `seq` (bigint, per page, monotonic), `group_id`, `epoch`, `sender_device`, `envelope` (bytea), `created_at`. Each row is one encrypted Yjs update.
- `doc_snapshots`: `page_id`, `base_seq`, `upload_id` (FK to `uploads`), `group_id`, `epoch`, `sender_device`, `envelope` (bytea, small), `media_upload_ids` (uuid[]), `created_at`.
  - The snapshot bytes are one encrypted Yjs state (`Y.encodeStateAsUpdate`) that covers all updates up to and including `base_seq`. They are an S3 object, not a column.
  - The client encrypts the state with the attachment scheme (§12.9: a random file key, STREAM AES-256-GCM in 64 KiB segments, Padmé padding), then uploads it with `POST /api/v1/uploads?kind=blob`. The existing upload route streams it to S3.
  - `envelope` is a small signed `doc_snapshot` envelope in the channel's MLS group. It holds the pointer: `{uploadId, fileKey, sha256, size}`. Only a member can read the file key, so the S3 object alone is useless.
  - `media_upload_ids` lists the media uploads that this snapshot references (see "Media in pages"). The client sends the list, because the server cannot read the page.
- `uploads` (existing): two new values of `purpose`, `page_snapshot` and `page_media`, and a new nullable column `page_id` (FK to `doc_pages`), as `message_id` works for messages. The claim rule is the message rule: an unclaimed encrypted blob of the caller (`messageClaimable`, `lib/uploads.ts:22`).

To load a page, a client reads the newest snapshot and then the updates after `base_seq`.

**Compaction and access by new members (one mechanism):** a client posts a new snapshot when either of these is true:

- More than 200 updates come after the newest snapshot.
- The epoch of the newest snapshot is older than the current epoch of the group.

The client sends `POST /pages/:pageId/snapshots {baseSeq, uploadId, envelope, mediaUploadIds}` after the upload. In one transaction, Takusen:

1. Checks that `baseSeq` is greater than the current one and not greater than the highest `seq` (compare-and-set). A loser gets 409, and its upload stays unclaimed, so the existing sweep of unclaimed uploads deletes it.
2. Claims the upload as `page_snapshot` for the page.
3. Inserts the row, and keeps the previous snapshot and the updates after it. Thus a damaged snapshot can be rolled back, and a later "page history" feature has data to show.
4. Deletes the older snapshot rows and updates, and their upload rows through `deleteAttachmentRows`, so that no S3 object leaks.

A page has at most two snapshot objects in S3 at one time.

The second condition re-encrypts the page in the current epoch. A member who joins in epoch N needs only the newest snapshot and the updates after it. This works with `historyVisibility = joined` too. Until an online member makes that snapshot, the new member sees "Waiting for a member to share this page".

**Where the data lives:**

| Data | Store | Form |
|---|---|---|
| Page tree (id, parent, position, timestamps) | Postgres `doc_pages` | plaintext metadata |
| Page title | Postgres `doc_pages.title_envelope` | ciphertext |
| Edits | Postgres `doc_updates.envelope` | ciphertext |
| Snapshot bytes (full page state) | S3 object (via `uploads`, purpose `page_snapshot`) | ciphertext |
| Snapshot pointer and file key | Postgres `doc_snapshots.envelope` | ciphertext |
| Images, video and files in pages | S3 object (via `uploads`, purpose `page_media`) | ciphertext |
| Media pointers and file keys | inside the Yjs page state | ciphertext |
| Live edits in transit | Redis pub/sub `guild:{id}`, then the gateway | ciphertext, not stored |
| Presence and cursors | Redis pub/sub `guild:{id}`, then the gateway | ciphertext, not stored |

Postgres keeps only rows of bounded size: an edit envelope has the existing 32 KiB cap (`TAKUSEN_MAX_ENVELOPE_BYTES`), and a pointer envelope is less than 1 KiB. S3 holds all bytes that grow with the page. The existing upload cap `TAKUSEN_MAX_UPLOAD_BYTES` (25 MiB) applies to each object. A new `TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES` (default 100 MiB) is the cap for a snapshot upload, because one large page with long tables can pass 25 MiB before media.

**Media in pages:**

1. A member drops an image, video or file into the editor. The client encrypts it with `encryptAttachment` and uploads it with `POST /api/v1/uploads?kind=blob`, as a message attachment.
2. The client claims it with `POST /pages/:pageId/media {uploadIds}`. Takusen sets `purpose = page_media` and `page_id`.
3. The editor inserts a node with the pointer `{uploadId, fileKey, sha256, size, mime, name, dimensions}`. The pointer is part of the Yjs state, so it is encrypted with the page.
4. A reader fetches the object from `/files` and shows it as a decrypted blob URL (`hooks/use-decrypted-blob.ts`, `lib/blob-url-cache.ts`), as message attachments do.

**Media garbage collection.** The server cannot see which media a page still uses. Thus each snapshot carries `media_upload_ids`. The daily DS sweep in the gRPC process deletes a `page_media` upload when all of these are true:

- It is not in the `media_upload_ids` of the current snapshot or the previous snapshot.
- It is older than 30 days, so that an undo or a restore can still find it.
- It is not referenced by an update after the current snapshot. The client sends the claim again when it adds the media, so a recent claim sets a `last_referenced_at` timestamp.

A member with edit rights can remove media from a page, so a false `media_upload_ids` list gives them no new power. The 30-day delay is the recovery window.

**Storage quota:** worst case, one guild fills the bucket. Takusen counts the bytes of `page_snapshot` and `page_media` uploads for each guild. A new upload claim over `TAKUSEN_GUILD_PAGE_STORAGE_BYTES` (default 10 GiB, 0 = no limit) gets 413 `StorageQuotaExceeded`. The count is a column `guilds.page_storage_bytes`, which the claim and the delete update in their transactions.

**Deletes:** a page delete, a channel delete and a guild delete remove the page uploads with `deleteAttachmentRows`, so that no S3 object leaks. Add the page uploads to the delete paths in `lib/guilds.ts`.

### 3. Encryption: doc envelopes in the channel's MLS group

- A pages channel uses the same MLS group as a text channel: the guild `public_set` group when the channel is public, and its own `channel` group when it is private (§12.6).
  - Replace each hardcoded `type === 'text'` check in the MLS layer with one helper, `hasTextGroup(type)`, that returns true for `text` and `pages`.
  - The checks are in: `lib/mls/membership.ts:128`, `lib/mls/readers.ts:67`, `repo.drizzle.ts:72` (`listGuildTextChannels`), `repo.in-memory.ts:215`, `lib/wire.ts:81` and `api/v1/channels/[id]/route.ts:71`.
- The envelope format is §12.8.1, with four new kinds: `doc_update`, `doc_snapshot`, `doc_awareness` and `doc_title`.
  - The header also binds `page_id[16]`. The AAD thus prevents moving an update from one page to another page or channel.
  - The key uses the same derivation as messages, with a different label: `K_doc = HKDF(S_e, "hachiman doc key v1" ‖ sender_leaf, salt)`. A message key and a doc key can never be the same.
  - The sender's leaf key signs each doc envelope, as it signs messages. A receiver drops an envelope with a bad signature.
- New `CryptoApi` methods (`pkgs/hachiman-crypto/src/api.ts`, with contract §12 in the same change):
  - `encryptDoc({ channelId, pageId, kind, bytes }) → { envelope, groupId, epoch }`
  - `decryptDoc(items: EncryptedDocItem[]) → DocDecryptResult[]`
  - These return Yjs bytes and title text to the UI thread. This is decrypted content, not key material, so the "no keys outside the Worker" rule holds.
- The existing rules apply: commit pending Removes before encrypting (§12.6), keep the retained epoch secrets for old envelopes, and raise a fork alert on a decrypt failure.

### 4. Live updates and presence over Redis

The existing bus is Redis pub/sub on `guild:{id}`, and the gateway filters it by VIEW_CHANNEL (`bus.go:88`, `session.go:467`). Both new paths use that bus.

**Edits (persistent):**

1. The editor makes a Yjs update. The provider merges updates for 100 ms (`Y.mergeUpdates`), then encrypts them.
2. The client sends `POST /api/v1/pages/:pageId/updates {envelope}`. Takusen checks SEND_MESSAGES, inserts the row with the next `seq`, then publishes `DOC_UPDATE {channelId, pageId, seq, senderDevice, envelope}` to `guild:{guildId}`.
3. The gateway delivers the update to the sessions that can view the channel. Each client decrypts it and calls `Y.applyUpdate`.

**Presence and cursors (ephemeral, no database):**

1. A new client→gateway op 5, `DOC_AWARENESS {channelId, pageId, envelope}`. The envelope contains the encrypted y-protocols awareness update: user, color, cursor and selection.
2. The gateway checks that the session can view the channel and that the channel is of type `pages`. It also checks a size cap of 8 KiB and a per-session rate limit of 20/s. It then publishes the `DOC_AWARENESS` dispatch to `guild:{guildId}` with the `channelId`.
3. A client sends its awareness state when it opens a page, when its cursor moves (throttled), and every 15 s. y-protocols drops a peer after 30 s without an update. A new viewer sends its state with `query: true`, and peers reply with their own state.

**Out of the resume buffer:** `DOC_UPDATE` and `DOC_AWARENESS` are high-volume. In the 500-frame resume buffer, they would push out message events. Thus the gateway dispatches both without `seq` and without an append to `events:{sessionId}` (a new `dispatchEphemeral` in `session.go`).

- A client finds a missed update from a gap in the per-page `seq`.
- After RESUMED or READY, the client re-reads the tail with `GET /pages/:pageId/updates?after=<seq>`.
- Yjs ignores an update that it already has, so a duplicate does no damage.

**Gateway read limit:** today `conn.go` sets no WebSocket read limit. Add `SetReadLimit(64 KiB)` in the same change, because clients now send payloads.

### 5. Pages and links

- **REST** (contract §4, §12.12). All routes need VIEW_CHANNEL. Every route except the GET routes also needs SEND_MESSAGES.
  - `GET /channels/:id/pages`: the tree, with title envelopes.
  - `POST /channels/:id/pages {parentId, position, titleEnvelope}` → `PAGE_CREATE`
  - `PATCH /pages/:pageId {parentId?, position?, titleEnvelope?}` → `PAGE_UPDATE`. Takusen rejects a cycle in the tree.
  - `DELETE /pages/:pageId`: deletes the page and its subtree → `PAGE_DELETE`
  - `GET /pages/:pageId/state`: `{snapshot: {envelope, uploadId, fileUrl} | null, updates[]}`. The client downloads the snapshot object from `/files` (Range is supported) and decrypts it.
  - `GET /pages/:pageId/updates?after=`, `POST /pages/:pageId/updates`
  - `POST /pages/:pageId/snapshots {baseSeq, uploadId, envelope, mediaUploadIds}`
  - `POST /pages/:pageId/media {uploadIds}`: claims media uploads, or refreshes their `last_referenced_at`
- A new pages channel gets one root page, "Untitled". The client that creates the channel makes this page, because only a client can encrypt the title.
- **Links:** a link to a page is a normal markdown link with the target `hachiman:page/<pageId>`. In markdown export, it stays a valid link.
  - In the editor, a click on such a link opens that page in the panel. A link whose page is in another pages channel also selects that channel.
  - The editor shows the current decrypted title of the target, not the link text, so a renamed page shows the new title in every link.
  - The slash menu gets "Link to page" (a page picker) and "New sub-page" (it makes a child page and inserts the link).
  - Backlinks ("pages that link here") are client-side only, because the server cannot read content. Skipped in v1. Add them when the page count makes navigation hard.
- **Permissions:** no new bits.
  - VIEW_CHANNEL: read the pages and send presence.
  - SEND_MESSAGES: edit, create, move and delete pages.
  - An admin makes a read-only document by denying SEND_MESSAGES in an overwrite.
  - The server cannot check what an edit contains. A member who can edit can also damage a page. The previous snapshot (decision 2) is the recovery path.

### 6. UI

- **Layout** (`components/shell/shell.tsx`): today it is a fixed CSS grid (72 / 240 / main / 240). For a `pages` channel, put the main area and the right panel in a `react-resizable-panels` `PanelGroup` (MIT), through a shadcn `components/ui/resizable.tsx`.
  - Center: the normal `ChatBody`, so the channel has chat about the document.
  - Right: `PagesPanel` in place of `MemberList`. The default width is 50% of the space, the minimum is 320 px, and the panel can collapse.
  - `prefsStore` keeps the width for each channel.
  - The title-bar toggle that shows and hides the member list shows and hides the pages panel in a pages channel.
  - Other channel types keep the grid. The one type branch at `shell.tsx:54-68` grows one case.
- **PagesPanel** (`components/docs/`):
  - A header with a breadcrumb of the page path, a page-tree popover (drag to reorder or nest it, with the installed `@dnd-kit`), presence avatars and "Copy as markdown".
  - The body is the Crepe editor, bound to the page's `Y.Doc`.
  - Remote cursors show the member's name and color. y-prosemirror's cursor plugin draws them.
- **Services:**
  - `services/docs/DocProvider.ts`: one `Y.Doc` and one `Awareness` for each open page. It does load, batch, encrypt, send, apply remote updates, fill gaps and post snapshots.
  - `services/DocsService.ts`: the page tree for each channel, title decryption, and the store updates.
  - `stores/docsStore.ts`: the tree, the open page for each channel, and the presence for each page. It holds no Yjs objects; those stay in the provider.
  - The rules in CLAUDE.md apply: Zustand selectors with `useShallow` and hoisted empty constants, decrypt before store.
- **Channel creation:**
  - `create-channel-dialog.tsx`: a third type card with the `FileText` icon.
  - `channel-sidebar.tsx`: `ChannelRow` shows the icon by type, and the category menu gets a "Create pages channel" item.
  - `channel-pane.tsx` `ChannelTitle`: the icon by type.
  - `permission-labels.ts`: use the text bits.
  - Move the icon choice into one `channelIcon(type)` helper instead of three ternaries.
- **Preview mode:** `dev/preview/fixture.ts` adds a pages channel with two linked pages. `stubs.ts` stubs the page routes and echoes `DOC_UPDATE` to the same client, so a second tab is not needed to see the panel work.

### 7. Out of scope for v1

- The media UI (drop, paste, the image and video nodes in the editor). The storage, claims, quota and sweep are in v1, so the media UI is only a client change. It comes in phase 5.
- Page history UI. The previous snapshot is kept, so the data for a "restore previous version" button exists.
- Search, backlinks, comments, and pages channels in DMs.

## Phases

Each phase updates `docs/gateway-protocol.md` in the same change.

1. **Channel type and storage (Takusen + client types):**
   - add `pages` to the enum in `db/schema.ts:42`, the `ChannelType` in `types.ts:5` and `rest.ts:116`, `repo.ts:64`, and the channel create zod schema
   - the `hasTextGroup` helper
   - the three tables, the `uploads` changes (`page_id`, the two purposes), `guilds.page_storage_bytes`, and the repo seam (Drizzle + in-memory, as `MlsRepo`)
   - the page routes and the update/snapshot/media routes, with the `seq` allocation, the snapshot compare-and-set and the quota
   - page uploads in the delete paths, and the media sweep in the daily DS sweep
   - `PAGE_*` and `DOC_UPDATE` events in `GatewayEvents`
   - dev DB: reset and reseed per `feedback_dev_migrations.md`
2. **Crypto:** the doc envelope kinds, `page_id` in the header, the `K_doc` label in `constants.ts`, `encryptDoc`/`decryptDoc` in the Worker, and specs for round trip, wrong page, wrong kind, bad signature and old epoch.
3. **Gateway:**
   - op 5 `DOC_AWARENESS` with the view, type, size and rate checks
   - `dispatchEphemeral`, used for `DOC_UPDATE` and `DOC_AWARENESS`
   - `SetReadLimit`
   - the client's `GatewayClient.sendDocAwareness`
4. **UI:** start with the Crepe + collab spike, then:
   - the resizable layout
   - `PagesPanel`, `DocProvider` and `DocsService`
   - links and the slash menu items
   - the create dialog and the sidebar changes
   - the preview fixture
5. **Media in pages (UI):** drop and paste in the editor, an image node and a file node with decrypted blob URLs, and upload progress.
6. **Docs:** contract, README diagrams (the connection and event flow, the UI store/service layout), `apps/hachiman/README.md`, `apps/takusen/README.md`, CLAUDE.md. Write the prose with asd-ste100.

## Critical files

- **Takusen:**
  - `apps/takusen/src/db/schema.ts`
  - `src/lib/mls/{membership,readers,repo,repo.drizzle,repo.in-memory}.ts`
  - `src/lib/wire.ts`
  - `src/app/api/v1/guilds/[id]/channels/route.ts`
  - `src/app/api/v1/channels/[id]/route.ts`
  - new `src/app/api/v1/channels/[id]/pages/` and `src/app/api/v1/pages/[pageId]/`
  - new `src/lib/docs/` (the repo seam and the service)
  - `src/lib/guild-access.ts` (`publishToChannel`)
  - `src/lib/uploads.ts` (the page claims), `src/lib/guilds.ts` (the delete paths), the daily DS sweep in `src/grpc/`
  - `.env.example`: `TAKUSEN_MAX_PAGE_SNAPSHOT_BYTES`, `TAKUSEN_GUILD_PAGE_STORAGE_BYTES`
- **Crypto:**
  - `pkgs/hachiman-crypto/src/{api.ts,constants.ts}`
  - `src/envelope/{codec,service}.ts`
  - `src/worker/`
- **Client:** `pkgs/hachiman-client/src/{types,rest,gateway,client}.ts`
- **Gateway:** `apps/hachiman-server/cmd/hachiman-gateway/{conn,session,bus}.go`
- **Shared UI:**
  - `apps/hachiman/src/components/shell/{shell,channel-pane}.tsx`
  - `components/{channel-sidebar,create-channel-dialog}.tsx`
  - new `components/docs/`, `services/docs/`, `stores/docsStore.ts`
  - `services/hachiman.ts` (the event mirror)
  - `dev/preview/{fixture,stubs}.ts`
- **New dependencies** (in `apps/hachiman` only): `@milkdown/crepe`, `@milkdown/plugin-collab`, `@milkdown/kit`, `yjs`, `y-protocols`, `y-prosemirror`, `react-resizable-panels`. All are MIT. `@hachiman/client` and `@hachiman/crypto` get no new dependencies.

## Reuse

- `publishToChannel` (`lib/guild-access.ts:164`) and the `guild:{id}` bus with the gateway's VIEW_CHANNEL filter.
- `requirePermission` and `requireChannelAccess`, as in the typing route (`api/v1/channels/[id]/typing/route.ts`).
- The `MlsRepo` and `MediaNodesRepo` pattern of one interface with a Drizzle and an in-memory implementation.
- The message key derivation and the signature code in `envelope/service.ts`, with a new label.
- `@dnd-kit` (installed) for the page tree.
- The decrypt-before-store and retry pattern of `services/message-decrypt.ts`.

## Verification

- **Takusen (`pnpm -F @hachiman/takusen test`, in-memory repo):**
  - `seq` increases with no gaps when two senders post at the same time.
  - The snapshot compare-and-set rejects an old `base_seq` and keeps the previous snapshot. A third snapshot deletes the oldest snapshot's upload row and object.
  - A claim over the guild quota gets 413, and a delete gives the bytes back.
  - The media sweep deletes an unreferenced upload after 30 days and keeps a referenced one.
  - A page delete and a channel delete leave no upload rows of the page.
  - A tree move that makes a cycle gets 400.
  - A user without SEND_MESSAGES gets 403 on writes and 200 on reads.
  - A pages channel gets the `public_set` group or the `channel` group by its overwrites.
- **Crypto (`pnpm -F @hachiman/crypto test`):**
  - Two devices round-trip a Yjs update and a snapshot.
  - An envelope moved to another page fails.
  - An envelope from a removed member's new epoch fails.
  - A snapshot made in epoch N opens for a member who joins in epoch N.
- **Gateway (`go test ./...`):**
  - The op 5 checks: no view gives a drop, a wrong channel type gives a drop, more than 8 KiB gives a drop, and the rate limit drops the excess.
  - An ephemeral dispatch does not enter the resume buffer.
  - A frame over the read limit closes the socket.
- **E2EE canary** (`apps/takusen/src/e2ee/canary.integration.ts`): add a page title, page text and an image with unique strings. Check that the strings are in no Postgres column, no S3 object, no Redis frame and no gateway frame.
- **Manual** (`pnpm dev`, with two browsers signed in as two users):
  - Make a pages channel. Type in both browsers, and check that the text and the cursors show in the other browser.
  - Drag the panel border.
  - Make a sub-page, link to it, and click the link.
  - Rename the sub-page, and check that the link shows the new title.
  - Reload, and check that the content stays.
  - Kill the gateway for 10 s, edit in one browser, and check that the other browser catches up.
- **Preview:** `?preview` shows the pages channel and the panel with no backend (use the verify skill).
- **Typecheck:** `tsgo` in every changed package.

## Open decisions (defaults chosen; change them in review)

1. **Chat in the channel:** yes. The center shows chat, and the right shows the document, as in the artifact layout. The other choice is a document-only channel with the panel at full width.
2. **Edit permission:** SEND_MESSAGES. The other choice is a new `EDIT_PAGES` bit (bit 12 is free).
3. **Guild page quota:** 10 GiB for each guild. The other choice is no limit (`0`) and a bucket-level alert.
4. **New member before a re-encrypted snapshot exists:** the member waits. The other choice is `historyVisibility = shared` as a forced default, so that history bundles cover the gap.
