# Page banner plan

This plan adds an encrypted banner to the top-level pages of a pages channel, on desktop and on mobile. It is the plan for an implementation workflow. It does not change code.

## Context

The mobile page screen (M38) shows a purple gradient as the page "banner". `components/docs/page-hero.tsx` makes it from a hash of the page id and the guild tint (`coverHues`, `pageCover`). It is decoration only. It carries no data, and the user cannot change it. Desktop has no hero at all: `pages-panel.tsx` renders `PanelHeader`, then `Breadcrumb`, then `OpenPage`.

The user wants a real banner. The root page of a pages channel can have a banner image. Its sub-pages show the same banner. Both the desktop panel and the mobile page screen show it.

Constraints:

- Every channel type is E2EE. A page banner is page content, so the server must not see the image or its key. Avatars, icons and guild banners stay plaintext, but a page banner does not.
- Page media is an encrypted §12.9 blob, claimed as `page_media` of one page. The daily media sweep deletes a `page_media` upload after 30 days when nothing references it.
- `page-screen.tsx` and `page-actions.tsx` belong to the W6 workflow that is open in the working tree. A banner change to `page-screen.tsx` waits for the W6 commit.

Two designs were scored:

- **Design 1** keeps the banner pointer in the root page's Y.Doc (`Y.Map('meta')`, key `banner`), like labels.
- **Design 2** keeps the banner as a new page envelope kind `doc_banner` on the `doc_pages` row, next to `title_envelope`.

| Criterion | Design 1 (Y.Doc meta) | Design 2 (row envelope) |
|---|---|---|
| E2EE correctness | 9. Inside the doc envelopes. | 9. Same envelope crypto as titles. The server also learns when a banner changes. |
| Survives the media sweep | 6. Needs a `collectMediaUploadIds` change and a forced snapshot. Depends on clients that post snapshots. | 9. A server column references the ids. No client action keeps it alive. |
| Smallest contract and server change | 10. Text only, no server code. | 5. New envelope kind, migration, PATCH rules, sweep rule. |
| Realtime behaviour | 6. Through `DOC_UPDATE`, but sub-pages need a hidden watcher provider. | 9. `PAGE_UPDATE` reaches every viewer of the channel. |
| Sub-page inheritance cost | 3. A sub-page loads the root's whole snapshot and update tail. | 10. The banner comes with the page list. |
| Desktop and mobile UX | 7. Needs a `known` flag and the watcher before a paint. | 8. The data is in the store at once. |
| Implementation size and risk | 4. Watcher lifecycle (ref counts, handover, linger, leaks) in `DocsService`. | 6. Wide but follows the title pattern at every step. |
| **Total (of 70)** | **45** | **56** |

**Winner: Design 2.** The banner is page-row metadata, like a title. Sub-pages need it without loading the root, and the title path already solves decryption, catch-up, re-wrap for new members and realtime. Design 1 is smaller on the server, but it moves the cost into a new provider lifecycle in `DocsService` and into a snapshot rule that a quiet page may never trigger.

Grafted from Design 1: strict client validation of the pointer (image mime list, size cap, dimensions), thumbnail-first rendering, the `afterTile` breadcrumb spacing, the tile only with a banner, the hidden file input mounted outside any sheet, and "render nothing until the banner is known" to stop an "Add banner" flicker.

## Decisions

Main-session decisions, kept:

1. Only a root page has a banner. Its sub-pages show the same banner, read-only. In a channel with one root page it acts as the channel banner.
2. A user who may edit the page (`has(perms, SEND_MESSAGES)`, the rule of every W route) can add, change and remove the banner, on the root page only.
3. With no banner the hero shows no gradient. It is a plain header. An editor on the root page gets an "Add banner" control.
4. The banner is E2EE. The server stores only ciphertext and the upload ids.

Changes, with the reason:

1. **"The root page" means the top-level ancestor.** A channel can have more than one top-level page: "Move to…" offers the top level, and the tree list can create top-level pages. Each top-level page can own a banner. A page shows the banner of `pagePath(pages, pageId)[0]`, but only when that page has `parentId === null`. `pagePath` stops at a missing parent, so for an orphan (its parent is not in the list yet, for example during a move) `path[0]` is not a root: show nothing and give no controls, else an editor gets an "Add banner" that the server rejects with 400. Do not use `flattenPages(pages)[0]`, because a reorder would then swap the banner silently.
2. **The banner is a row envelope, not Y.Doc content.** This is the Design 2 choice. The reasons are in the table above. The Y.Doc `meta` map keeps labels only.
3. **A move under another page clears the banner.** Design 2 kept a hidden banner on a moved page. That leaves a hidden row the re-wrap pass must handle, and the server root rule would reject the re-wrap. Instead Takusen keeps one invariant: `banner_envelope` is not null only when `parent_id` is null. A move clears the banner and gives its uploads the 30-day undo window. Moves of top-level pages under other pages are rare.
4. **The page tile shows only with a banner.** The 62 px tile that overlaps the cover is also decoration. With no banner the header is plain.
5. **No focal point in v1.** The image is centred with `object-cover`. The body is JSON, so a later `focusY` key needs no new kind.
6. **The image is downscaled and re-encoded before upload.** At most 2048 px wide, WebP 0.85, with a JPEG fallback on WebKit. This strips EXIF and GPS data, which every member could otherwise read, and keeps each view's download small. An animated GIF keeps only its first frame.
7. **No M41 actions-sheet row.** The hero control is enough. `page-actions.tsx` (W6) does not change.

## Data and E2EE design

**New page envelope kind `doc_banner = 5`** (§12.20).

- The body is the UTF-8 JSON of an `AttachmentPointer`, the same shape as an `hm_media` pointer: `uploadId, key, sha256, size, blobSize, mime, name, width, height, durationMs, blurhash, thumbnail`.
- The body is at most `MAX_PAGE_BANNER_BYTES = 8192`, the cap of `parsePointer`.
- The kind is in the header, and the header is the AAD. The server cannot pass a title or a snapshot pointer off as a banner. The page id is in the header, so the server cannot move a banner to another page.
- The Worker's `checkDocBody` for `doc_banner` checks strict UTF-8, a JSON object, `mime` as a string that starts with `image/`, and the size. Else `TooLarge` or `Malformed`. It ignores unknown keys.
- The UI checks fully and fails closed (`services/docs/banner.ts`, `parseBanner`):
  - `parsePointer` passes
  - `mime` is one of `image/png`, `image/jpeg`, `image/webp`, `image/gif` (no SVG)
  - `size` is at most `BANNER_MAX_BYTES` (8 MiB), and `blobSize` is at least `size` and at most `BANNER_MAX_BLOB_BYTES` (the §12.9 blob of an 8 MiB file). The download stops past the pointer's `blobSize` (`fetchBlob` `maxBytes`), so a hostile pointer at a larger upload cannot force a large download
  - `width` and `height` are not null
  - Else the banner is null.

**Storage on Takusen.**

- `doc_pages.banner_envelope bytea null`.
- `doc_pages.banner_upload_ids uuid[] not null default '{}'`: the `page_media` uploads of the banner (the file and its thumbnail). The client gives the list, because the server cannot read the envelope.
- The server never sends `banner_upload_ids` to clients.

**Set or change** (one PATCH, so the claim and the pointer commit together):

1. The client prepares the image, then `uploadAttachment` encrypts and uploads it (`?kind=blob`), with its thumbnail.
2. `encryptDoc({ kind: 'doc_banner', bytes: utf8(JSON.stringify(pointer)) })`.
3. `PATCH /pages/:pageId { banner: { envelope, uploadIds: uploadIdsOf([pointer]) } }`.
4. Takusen claims new ids as `page_media` of the page, adds the bytes to the quota and stores the envelope and the ids. Ids that the PATCH drops get `last_referenced_at = now()`.
5. `PAGE_UPDATE` goes to every viewer of the channel.

There is no separate `POST /pages/:id/media` call, so no window exists in which a pointer is stored but its upload is not claimed.

**Remove.** `PATCH /pages/:pageId { banner: null }`. The dropped ids get `last_referenced_at = now()`. The sweep deletes them after 30 days. That is the undo window.

**Sweep.** A `page_media` upload whose id is in `banner_upload_ids` of its page is never swept. No snapshot needs to list it.

**Lifecycle.** The banner uploads are `page_media` of the top-level page (`uploads.page_id` = that page). Each case:

| Event | What happens to the banner | Code change |
|---|---|---|
| Daily media sweep | Kept while its ids are in `banner_upload_ids`. Dropped ids go after 30 days | `page-media-sweep.ts` (fourth condition) |
| New snapshot, snapshot pruning, pointer re-wrap | No effect. The banner is not in the `Y.Doc`, and pruning deletes only `page_snapshot` uploads | None |
| New `Y.Doc` content | No effect. `collectMediaUploadIds` does not change | None |
| A sub-page moves to the top level | It becomes a root with no banner. Its sub-pages now show nothing, and an editor gets "Add banner" on it | None on the server |
| A sub-page moves under another root | It shows the banner of its new root (`PAGE_UPDATE` of the moved page) | None |
| The top-level page with a banner moves under another page | Takusen clears the banner in the same PATCH and touches its ids (30-day window). Its sub-pages now show the banner of the new root | `service.ts` |
| The top-level page is deleted | Its subtree goes too. `deletePage` deletes all uploads with the page ids (`deleteUploadsOfPages`), which include the banner, and gives back their quota | None. Add a test |
| The channel or guild is deleted | `deleteAttachmentRows` deletes the page uploads | None |
| A page moves to another channel | Not possible. Takusen rejects a `parentId` of another channel | None |
| A re-wrap for a new member | New envelope, same ids | `rewrap.ts`, `service.ts` |

**Re-wrap for new members.** The heads route gives the group and epoch of the banner envelope. A re-wrap pass decrypts a stale banner, encrypts the same bytes again and sends `banner: { envelope }` with no `uploadIds`, and with `ifUpdatedAt`. Without `uploadIds`, Takusen keeps the stored `banner_upload_ids` and claims nothing (a stored banner is required, else 400 `ValidationError`). This is the rule of the snapshot pointer re-wrap (§4 Pages "Re-wrap": "keeps the stored `media_upload_ids` and ignores the body list"). Reasons:

- The re-wrapper is usually not the uploader. If it sent ids from the pointer and they differ from the stored ids (an editor sent wrong ids, risk 3), the new ids need a claim that only the uploader can make (`claimPageMedia` checks `uploader_id`). The PATCH then gives 400 `UnknownUpload` on every pass, and the new members never see the banner.
- A re-wrap must not drop a media reference.
- The re-wrapper re-encrypts the raw `ok` bytes. It does not need to parse the pointer, as for titles.

**What the server learns.** That a page has a banner, when it changes, and the blob sizes. It already sees sizes and claim times of page media. It can withhold a banner or serve an older one (a rollback), as with titles. It cannot forge one or move it.

**Where the decrypted pointer lives.** `docsStore` `PageNode.banner: AttachmentPointer | null`. This follows the `messagesStore` precedent (`ChatMessage.attachments: AttachmentPointer[]`), which holds decrypted pointers with their file keys. The store never holds an envelope or a `Y.Doc`. Show the image only through `useDecryptedBlob`, never through a file URL. Rules:

- `docsStore` is not persisted (no `persist` middleware) and must stay so. Do not put the banner, its pointer or its object URL into `prefsStore`, `tabsStore`, `navStore`, `localStorage` or `sessionStorage`. Do not log a pointer (log `uploadId` only).
- CLAUDE.md "E2EE rules in the UI" says that `docsStore` holds the page tree and presence, and that a page media pointer is inside the `Y.Doc`. The banner pointer is the one exception. WP4 updates that line in CLAUDE.md.
- The upload preview is `URL.createObjectURL` of the prepared local file. Revoke it when the decrypted banner shows, on error and on unmount.

**What the server sees, item by item.**

| Item | Where | Plaintext to the server? |
|---|---|---|
| Image bytes and thumbnail bytes | S3 objects (`?kind=blob`, filename null) | No. §12.9 ciphertext |
| File key, sha256, mime, name, width, height | Pointer in the `doc_banner` envelope | No |
| The pointer JSON | `doc_pages.banner_envelope` | No. Only the header (group, epoch, kind, page, sender) |
| Upload ids of the banner | `doc_pages.banner_upload_ids` | Yes, ids only. The server already knows `uploads.page_id` |
| Blob sizes, the time of a change | `uploads.size`, `updated_at` | Yes, as for all page media |
| The file name | Pointer `name` | No. Always `banner.webp` or `banner.jpg`, so the original name does not reach other members either |
| EXIF and GPS | Removed by the re-encode | Not present |

## Contract changes (`docs/gateway-protocol.md`)

Change these sections in the same commit as `pkgs/hachiman-crypto/src/api.ts` and `constants.ts` (CLAUDE.md rule).

- **§1 Entity shapes**
  - `Page`: add `bannerEnvelope: string | null`, a base64url `doc_banner` envelope (§12.20). Not null only on a top-level page.
  - `PageHead`: add `banner: { groupId, epoch } | null`, from the header, as `title`.
- **§3 Postgres schema**, row `doc_pages`: add `banner_envelope bytea null` and `banner_upload_ids uuid[] default '{}'`. Notes: `banner_envelope` is null when `parent_id` is not null. `banner_upload_ids` are `page_media` uploads of the page.
- **§4 Pages**
  - Table, PATCH row: body `{parentId?, position?, titleEnvelope?, banner?: {envelope, uploadIds?: string[] /* 1 to 2 */} | null, ifUpdatedAt?}`. Add 413 `StorageQuotaExceeded`.
  - "Envelope checks": `banner.envelope` needs kind `doc_banner`.
  - "Compare-and-set": a banner re-wrap also sends `ifUpdatedAt`.
  - New bullet **"Banner"**:
    1. Takusen locks the page row once (after `lockTree` on a move). The `ifUpdatedAt` check uses the same locked row.
    2. A non-null `banner` needs the resulting `parentId` (the body value, else the stored one) to be null. Else 400 `ValidationError`.
    3. The envelope must pass the envelope checks.
    4. With `uploadIds`: each id must be in the stored `banner_upload_ids`, or be claimable as in "Media". Else 400 `UnknownUpload`. Without `uploadIds` (a re-wrap): the page must have a stored banner, else 400 `ValidationError`. Takusen keeps the stored ids and claims nothing.
    5. New claims add bytes to the quota. Above the limit: 413 `StorageQuotaExceeded`, and nothing of the request is stored.
    6. Ids that the PATCH drops, also on `banner: null`, get `last_referenced_at = now()`.
    7. A PATCH that sets a non-null `parentId` on a page with a banner clears the banner as `banner: null` does.
  - "Delete": no text change. The banner uploads are page uploads of the page, so the delete already removes them.
  - "Heads": also the group and epoch of the banner envelope. `banner` is null when the page has no banner or the header does not decode.
  - "Media": one sentence that a page banner is page media, claimed by the PATCH.
  - "Media sweep": a fourth condition. The upload is not in `banner_upload_ids` of its page.
- **§10 Client library**: `updatePage(pageId, { parentId?, position?, titleEnvelope?, banner?, ifUpdatedAt? })`.
- **§12.18 Takusen internal seams**: `DocEnvelopeInput.kind` adds `'doc_banner'`.
- **§12.20 Page envelopes**
  - Struct comment: `5 doc_banner`.
  - "Bodies": a `doc_banner` bullet (the pointer JSON, at most 8192 bytes, `MAX_PAGE_BANNER_BYTES`, an image mime).
  - After the labels paragraph: the banner is a row envelope, not a Y.Doc field. Only top-level pages have one. Sub-pages show the banner of their top-level ancestor.
  - "Server checks": the PATCH `banner.envelope` is checked as kind `doc_banner`.
  - "Access by new members", step 4: "a title or banner envelope of an older epoch or group". The client sends `PATCH {titleEnvelope?, banner?: {envelope}, ifUpdatedAt}`, with no `uploadIds`.
  - "Titles of the new member" and "The other members": the same catch-up applies to banners.
  - "Residual risk": the banner rollback and metadata lines above.

Also change `docs/ios-mobile-ui-spec.md` (WP6):

- Line 683 (F2 work, M38): the `PageHero` text ("a 116 cover from the guild tint or a hash of the page id ... with no stored data").
- Line 1061: `Page.updatedAt` now also changes on a banner patch.
- Line 1062: the deferral row. The cover is done as a row envelope (not in the `Y.Doc` meta map). The icon stays deferred.

## Takusen and server changes

**Schema** (`apps/takusen/src/db/schema-pages.ts`):

- `bannerEnvelope: bytea('banner_envelope')`, nullable.
- `bannerUploadIds: uuid('banner_upload_ids').array().notNull().default(sql\`'{}'::uuid[]\`)`.
- Run `pnpm -F @hachiman/takusen db:generate`. Commit the new SQL file and `drizzle/meta/`. The columns are nullable or have a default, so the migration works on a database with data.

**`lib/docs/wire.ts`**:

- `toPage` gives `bannerEnvelope` as base64url or null. Do not expose `bannerUploadIds`. `toPage` also feeds `GET /channels/:id/pages`, `PAGE_CREATE` and `PAGE_UPDATE`, so all three carry the field.
- `updatePageSchema` (it is `.strict()`, so an old Takusen rejects the field: see "Deploy order") adds `banner: z.object({ envelope: envelopeField, uploadIds: uniqueIds(2, 1).optional() }).strict().nullable().optional()`.
- `toPageHead` adds `banner`.

**`lib/docs/repo.ts`** and both implementations (`repo.drizzle.ts`, `repo.in-memory.ts`) in lockstep, with cases in `repo.conformance.ts`:

- `DocPagePatch` adds `bannerEnvelope` and `bannerUploadIds`.
- New `touchPageMedia(pageId, ids, now)`. It sets `last_referenced_at` on that page's `page_media` rows only.

**`lib/docs/service.ts`**:

- `updatePage`:
  1. When `body.banner !== undefined`, `body.ifUpdatedAt !== undefined`, or `body.parentId` is not null, lock the page row once with `repo.lockPage` (after `lockTree`). Use the locked row for the `ifUpdatedAt` compare and for the stored banner. Do not read the banner from the unlocked `page` that `loadPage` gave.
  2. Root check.
  3. `accept({ ..., kind: 'doc_banner' })`.
  4. With `uploadIds`: `fresh = ids not in stored`. `repo.claimMediaUploads(page.id, fresh, userId, now)`, then the quota add, else `quotaExceeded()`. `updatePage` needs `guildId` and `limits` in its input, as `claimMedia` has. Without `uploadIds`: a stored banner is required, and the ids stay.
  5. `touchPageMedia(stored ids not in ids)`.
  6. The patch.
- `listPageHeads` decodes the banner header too.

**Other files**:

- `app/api/v1/pages/[pageId]/route.ts`: pass `access.guildId` and `docsLimits()` (as `pages/[pageId]/media/route.ts` does). Update the PATCH doc comment.
- `lib/mls/envelopes.ts:119`: add `'doc_banner'` to the kind union.
- `lib/page-media-sweep.ts`: `isUnreferencedPageMedia` also takes the banner ids. The SQL adds `not exists (select 1 from doc_pages p where p.id = uploads.page_id and uploads.id = any(p.banner_upload_ids))`. `InMemoryPageMediaSweepRepo` gets a `banners: Map<pageId, string[]>` and follows. The sweep tests are in `src/grpc/mls-scheduler.test.ts`.
- `apps/takusen/README.md` line 240 (the `service.ts` row): add the banner claim and the move rule.

**Gateway and media**: no change. No Go code reads `Page`, and `PAGE_UPDATE` relays as is. `GATEWAY_MIN_CLIENT_VERSION` does not change: old clients ignore `bannerEnvelope`.

**Deploy order**: Takusen with the kind-5 codec ships before clients send `doc_banner`.

## Client data layer

**Crypto** (`pkgs/hachiman-crypto`):

- `src/constants.ts`: `DocEnvelopeKind.BANNER: 5`, `MAX_PAGE_BANNER_BYTES = 8192`.
- `src/api.ts`: `'doc_banner'` in `DocEnvelopeKindName`, and the `EncryptDocInput` doc comment.
- `src/envelope/codec.ts`: the `DOC_KIND` map and the `checkDocBody` branch.
- The `ds` entry uses the same codec, so Takusen accepts kind 5 with no extra parser.

**Client library** (`pkgs/hachiman-client`):

- `src/types.ts`: `Page.bannerEnvelope: B64url | null`, `PageHead.banner`.
- `src/rest.ts`: the `banner` field of `UpdatePageBody`.
- No crypto in this package.

**Shared UI** (`apps/hachiman/src`):

- `stores/docsStore.ts`:
  - `PageNode extends Omit<Page, 'titleEnvelope' | 'bannerEnvelope'>`.
  - Add `banner: AttachmentPointer | null` and `bannerPending: boolean`. `titles.ts` `nodeOf` lists each field by hand, so it must add both.
  - A pending banner does not make the title pending.
  - A banner that fails to decrypt or to parse is `banner: null, bannerPending: false`. An editor then sees "Add banner" and can replace it.
- `services/docs/banner.ts` (new): `parseBanner(bytes)` with the strict checks above, and `BANNER_MAX_BYTES`.
- `services/docs/titles.ts`:
  - `decryptTitles` adds one `doc_banner` item per page with a `bannerEnvelope` (id `${pageId}:banner`) to the same `decryptDoc` batch.
  - `titleNode` takes both results. `ok` gives `parseBanner(bytes)`. `pending` sets `bannerPending`.
  - The retry and the `epoch_ahead` catch-up include pages with a pending banner.
  - `keepBanner`, next to `keepTitle`: keep the old decrypted banner while a newer one is pending.
  - `sameNode` also compares `banner?.uploadId` and `bannerPending`.
- `services/docs/rewrap.ts`:
  - `staleBanner(h)` next to `staleTitle`.
  - `rewrapTitle` becomes `rewrapRow`. It re-wraps a stale title and/or banner in one PATCH with `ifUpdatedAt`.
  - The banner part sends `banner: { envelope }` with no `uploadIds` (see "Re-wrap for new members"). It re-encrypts the `ok` bytes as they are, without `parseBanner`. Only an `ok` result is re-wrapped. `PageConflict` skips the page.
  - `rewrapChannel` returns early with `!heads.some(staleTitle)`. Change the gate and the second heads read to `staleTitle(h) || staleBanner(h)`, else a page whose title is current but whose banner is stale is never re-wrapped.
- `services/docs/DocsService.ts` and `types.ts`:
  - `setBanner(pageId, file, { signal, onProgress })`: check that the page is a root in the store (else throw before any upload), `prepareBannerImage`, check `BANNER_MAX_BYTES`, then `uploadAttachment`, then `encryptDoc`, then `rest.updatePage(pageId, { banner: { envelope, uploadIds: uploadIdsOf([pointer]) } })`, then `upsertFromEvent` with the result.
  - `removeBanner(pageId)`: `rest.updatePage(pageId, { banner: null })`.
- `services/docs/page-tree.ts`: `rootOf(pages, pageId)`. It returns the id of `pagePath(pages, pageId)[0]` only when that page has `parentId === null`, else null (an orphan, or a page that is not in the list).
- `lib/banner-image.ts` (new): `prepareBannerImage(file)`.
  - `createImageBitmap` applies the EXIF rotation.
  - Scale to at most 2048 px wide (`bannerSize(w, h)`, pure).
  - `canvas.toBlob('image/webp', 0.85)`. If the result is `image/png` (WebKit), encode again as `image/jpeg` 0.85.
  - Return `new File([blob], 'banner.webp' or 'banner.jpg', { type })`.
- `hooks/use-page-banner.ts` (new): `usePageBanner(channelId, pageId)` returns `{ rootId, isRoot, banner, known }`.
  - Use single-value selectors only. `banner` is the stored reference or a module constant `null`, never a fresh object.
  - `known` is false while the pages of the channel are not loaded, or while the root's banner is pending. Render nothing then. A pending title does not matter: it must not hide a banner that decrypted.
  - `isRoot` is `rootId === pageId`. With `rootId === null`, the result is `{ banner: null, known: true, isRoot: false }`: no banner and no controls.
- `components/docs/page-media.tsx`: export `claimErrorText` for the 413 text. Upload errors use `uploadErrorText`.

## Desktop UI

The banner is in `components/docs/pages-panel.tsx`, between `PanelHeader` and `Breadcrumb`. The view itself is `PageBanner` in the new file `components/docs/page-banner.tsx`, variant `panel`. Do not put it in `page-hero.tsx`: `page-screen.tsx` imports `PageHero` with `{ pageId, tint }`, and that file must keep compiling until WP6 switches it (see "Work packages").

- **Banner set**: full panel width, 120 px high (4.5:1 at the default 540 px, 3:1 at 360 px), `object-cover`, centred. It does not scroll, because only the editor scrolls.
  - While it loads: the decrypted thumbnail, blurred, over `bg-surface-window`. Then the full image.
  - The image is decorative: `alt=""`.
- **Editor on the root page**: on hover or focus-within, two `IconButton`s at the top right, "Change banner" and "Remove banner", with tooltips. Use the root `TooltipProvider`. Do not add one.
- **No banner, editor on the root page**: a quiet "Add banner" text button (`text-text-tertiary`, small, with an image icon) at the right end of the breadcrumb row. It is always visible, so keyboard users can reach it.
- **No banner otherwise**: nothing. The breadcrumb comes first, as today.
- **Sub-page**: the root's banner, with no controls.
- **`MoreMenu`**: on the root page for editors, "Add banner", or "Change banner" and "Remove banner".
- **Uploading**: the local preview with a veil and a progress line. Errors show in a toast through `useAction`.
- The hidden `<input type="file" accept={PROFILE_IMAGE_TYPES}>` is mounted in `PageBanner`. `MoreMenu` calls its `pick()`.
- `PagesPanel` needs no doc handle. The data comes from the store.

A single scroller for banner and editor would touch `page-editor.tsx` (W6). Do not do it now.

## Mobile UI

The banner is `PageBanner` variant `screen` (`components/docs/page-banner.tsx`, WP5). `components/mobile/page-screen.tsx` changes in `PageScreenBody` only (lines 203 and 207 in the working tree today; W6 can move them): drop `useGuildTint` and the `PageHero` import, and render `<PageBanner variant="screen" channelId pageId canEdit />` in the loading branch and in the `OpenPage` head. Pass `afterTile` to the screen `Breadcrumb` when the tile shows. WP6 then deletes `components/docs/page-hero.tsx` and `page-hero.test.ts`, which have no other user (`coverHues`, `pageCover` and `PageHero` are used only there).

| State | What shows |
|---|---|
| Banner set | A 116 px full-width image, `object-cover`, centred. The 62 px tile overlaps the bottom left by 30 px. |
| Banner set, editor on the root page | Also a "Change banner" chip at the bottom right: 28 px visual, 36 x 36 hit area, `bg-black/40`. It opens a menu sheet with "Choose image" and "Remove banner". Copy the pattern of `ArtworkButton` in `settings/guild-overview-mobile.tsx`. |
| No banner, editor on the root page | One "+ Add banner" row, 36 px high, `px-5`, `text-text-tertiary`, styled like "Add label", above the breadcrumb. No tile. |
| No banner otherwise, or sub-page with no root banner | Nothing. No cover and no tile. The breadcrumb comes first. |
| Not known yet | Nothing, so the "Add banner" row does not flicker. |
| Uploading | The local preview, a veil and a progress line (`UploadingVeil` pattern). |

Rules:

- "Choose image" calls `pick()` synchronously inside the tap, so iOS opens the picker. The hidden input is mounted in `PageBanner`, outside the sheet, because the sheet unmounts on close.
- The `Breadcrumb` screen variant (`page-parts.tsx:74`) has margins tuned to the tile (`mt-[1.5px] -mb-[10.5px]`). Add an `afterTile` prop and use normal spacing when there is no tile.
- The hero scrolls away with the text in the one page scroller, so the keyboard case needs no change.
- The iOS host needs no change. `Info.plist` already has the photo and camera keys, and WKWebView handles the file input.

Height budget:

- **393 x 852**: the scroller is about 673 px. The 116 px banner is about 3.4:1. Text starts about 232 px down with a banner.
- **375 x 667 (iPhone SE)**: the scroller is about 561 px (667 − 20 safe top − 52 nav − 34 foot). The 116 px banner is about 3.2:1. About 329 px of text shows with a banner. With no banner the header gives back about 110 px, so about 440 px of text shows.
- Keep 116 px at both widths, as M38 does.

## Work packages

Each file has one owner. Packages in the same step can run in parallel.

**Step 1**

- **WP1 Contract and crypto**
  - `docs/gateway-protocol.md` (all sections above)
  - `pkgs/hachiman-crypto/src/constants.ts`
  - `pkgs/hachiman-crypto/src/api.ts`
  - `pkgs/hachiman-crypto/src/envelope/codec.ts`
  - `pkgs/hachiman-crypto/src/envelope/doc.spec.ts`

**Step 2 (after WP1, in parallel)**

- **WP2 Takusen**
  - `apps/takusen/src/db/schema-pages.ts`, the new migration SQL and `apps/takusen/drizzle/meta/`
  - `apps/takusen/src/lib/docs/wire.ts`, `repo.ts`, `repo.drizzle.ts`, `repo.in-memory.ts`, `repo.conformance.ts`, `repo.in-memory.test.ts`, `service.ts`, `service.test.ts`
  - `apps/takusen/src/app/api/v1/pages/[pageId]/route.ts`
  - `apps/takusen/src/lib/mls/envelopes.ts`
  - `apps/takusen/src/lib/page-media-sweep.ts` and `apps/takusen/src/grpc/mls-scheduler.test.ts` (the sweep tests)
  - `apps/takusen/README.md` (line 240)
- **WP3 Client library**
  - `pkgs/hachiman-client/src/types.ts`
  - `pkgs/hachiman-client/src/rest.ts`
  - `pkgs/hachiman-client/src/rest.spec.ts`

**Step 3 (after WP1 and WP3)**

- **WP4 Shared UI data layer**
  - `apps/hachiman/src/stores/docsStore.ts`
  - `apps/hachiman/src/services/docs/banner.ts` and `banner.test.ts` (new)
  - `apps/hachiman/src/services/docs/titles.ts`, `titles.test.ts`
  - `apps/hachiman/src/services/docs/rewrap.ts`, `rewrap.test.ts`
  - `apps/hachiman/src/services/docs/DocsService.ts`, `DocsService.test.ts`, `types.ts`
  - `apps/hachiman/src/services/docs/page-tree.ts`, `page-tree.test.ts`
  - `apps/hachiman/src/lib/banner-image.ts` and its test (new)
  - `apps/hachiman/src/hooks/use-page-banner.ts` (new)
  - `apps/hachiman/src/components/docs/page-media.tsx` (export `claimErrorText` only)
  - `CLAUDE.md`, the "Pages:" line of "E2EE rules in the UI" only (the banner pointer in `docsStore`)

**Step 4 (after WP4)**

- **WP5 Shared view, desktop and preview**
  - `apps/hachiman/src/components/docs/page-banner.tsx` and `page-banner.test.ts` (new). Both variants: the desktop panel and the mobile screen (tile, chip, menu sheet, "+ Add banner" row)
  - `apps/hachiman/src/components/docs/page-parts.tsx` (`afterTile` on the screen `Breadcrumb`, a trailing slot on the panel `Breadcrumb` for "Add banner")
  - `apps/hachiman/src/components/docs/pages-panel.tsx` (the banner and the `MoreMenu` rows)
  - `apps/hachiman/src/dev/preview/fixture-pages.ts` (`bannerEnvelope` on each fixture page, a stub `doc_banner` envelope on `rfc`), `attachments.ts` (the banner image), `stubs.ts` (`updatePage` stores `banner`, clears it on a move under a parent, and `getPageHeads` gives `banner`)
  - `apps/hachiman/README.md` if a diagram shows the pages data flow
  - WP5 does not touch `page-hero.tsx`, `page-hero.test.ts` or `page-screen.tsx`.

**Step 5 (after WP5 and after the W6 commit lands)**

- **WP6 Mobile**
  - `apps/hachiman/src/components/mobile/page-screen.tsx` (`PageScreenBody` only)
  - `apps/hachiman/src/components/docs/page-hero.tsx` and `page-hero.test.ts` (delete)
  - `docs/ios-mobile-ui-spec.md` (lines 683, 1061, 1062)

No file is in two packages. Before Step 5 the gradient hero still shows on mobile, and the desktop panel already shows the banner. `page-parts.tsx`, `pages-panel.tsx` and `page-media.tsx` are not modified in the W6 working tree today. If W6 touches them before WP4 or WP5 starts, WP4 and WP5 wait for the W6 commit too.

The end-to-end check needs WP2 as well. WP2 can finish any time before Step 5.

## Tests

- **Crypto** (`envelope/doc.spec.ts`): `doc_banner` round trip. `TooLarge` above 8192 bytes. Non-JSON or a non-image `mime` gives `Malformed`. A title envelope decrypted as `doc_banner` gives `wrong_kind`.
- **Takusen** (`service` tests, run on the in-memory repo):
  - a banner on a sub-page gives 400, and a banner with a move under a parent gives 400
  - a title envelope sent as a banner gives 400 `InvalidEnvelope`
  - the claim adds to the quota, and 413 stores nothing
  - a re-wrap by another member (`banner: { envelope }`, no `uploadIds`) passes and keeps the stored ids
  - a re-wrap without `uploadIds` on a page with no banner gives 400
  - deleting a top-level page with a banner deletes the banner uploads and gives back their quota
  - a foreign upload id gives `UnknownUpload`
  - removal and replacement set `last_referenced_at` on the dropped ids
  - a move under a parent clears the banner and touches its ids
  - the heads include the banner group and epoch
- **Takusen repo conformance**: the new columns and `touchPageMedia`, on both implementations.
- **Sweep**: a banner id is never swept. A dropped banner id is swept after 30 days.
- **Client library** (`rest.spec.ts`): the PATCH body with `banner` and with `banner: null`.
- **Shared UI**:
  - `banner.test.ts`: bad JSON, an SVG mime, oversize, missing dimensions.
  - `titles.test.ts`: a banner decrypts into the node, a pending banner keeps the old one, a banner change is stored, a pending banner does not make the title pending.
  - `rewrap.test.ts`: a stale banner gives one PATCH with `banner: { envelope }`, no `uploadIds`, and `ifUpdatedAt`. A page with a current title and a stale banner is re-wrapped. A `pending` banner is skipped.
  - `page-tree.test.ts`: `rootOf` for a nested page, a top-level page, and an orphan (null).
  - `banner-image` test: `bannerSize` and the PNG to JPEG fallback choice.
  - `page-banner.test.ts`: the state logic (controls only on the root for editors, nothing while not known, nothing for an orphan, no tile without a banner). WP6 deletes the gradient tests with `page-hero.test.ts`.
- **Checks**: `tsgo` typecheck of crypto, client, hachiman and takusen. `go test ./...` in `apps/hachiman-server` should not change.

## Verification steps

1. Run the crypto, client, shared UI and Takusen unit tests (the sandbox commands in CLAUDE.md).
2. Typecheck each changed package with `tsgo`.
3. In `?preview` mode, with the verify/run skill:
   - Desktop: open `rfc` (banner set), `glossary` (inherited, no controls) and `playbook` (no banner, "Add banner" for the editor). Add, change and remove a banner on `playbook`.
   - Mobile at 393 x 852 and 375 x 667: the same three pages. Check the tile, the chip, the "Add banner" row, the breadcrumb spacing with and without the tile, and the picker from the sheet.
   - Dark and light themes.
4. With the full stack (Takusen, gateway, two signed-in devices of two users):
   - User A sets a banner on a root page. User B sees it at once on the root page and on a sub-page.
   - In the database, `banner_envelope` is ciphertext and the upload row is `page_media`, `encrypted`.
   - A user without SEND_MESSAGES sees the banner and no controls. A direct PATCH from that user gives 403.
   - Invite user C. After the re-wrap pass, C sees the banner.
   - Remove the banner. The upload row stays, with a fresh `last_referenced_at`.
   - Move the root page under another page. Its banner is cleared, and user B sees that at once.
   - Move a sub-page to the top level. It shows no banner, and an editor sees "Add banner" on it.
   - Delete the root page. The banner upload rows and objects are gone, and `guilds.page_storage_bytes` drops by their size.
   - In the browser devtools: `localStorage` and `sessionStorage` have no banner key, pointer or object URL.

## Risks

1. **Wider change.** Crypto, contract, Takusen, client and UI change together. Mitigation: the title path is the model at every step, and WP1 lands the contract first.
2. **Missing re-wrap.** Without the `rewrapRow` change, members who join later never see a banner. The test in `rewrap.test.ts` guards it.
3. **Client-supplied upload ids.** The server cannot check that `uploadIds` match the pointer. An editor could send wrong ids, and the banner would then be swept after 30 days. Editors can already damage a page in many ways, so this adds no new trust. A re-wrap sends no ids, so wrong ids do not also block the re-wrap for new members.
4. **Concurrent sets.** The last write wins. The other upload is claimed, dropped from the row with a fresh `last_referenced_at`, and swept after 30 days. It counts toward the quota until then.
5. **A move clears the banner.** A user who moves a top-level page under another page loses its banner, with no warning: the move callers ("Move to…" in `page-actions.tsx` and `page-move.ts`, both W6, and `components/docs/use-page-tree-actions.ts`) do not change here. The upload stays for 30 days, but no UI restores it. This is open for a user decision (see the end).
6. **`PAGE_UPDATE` reloads a waiting page.** A banner change makes a page that waits for keys load again, as a rename does. The cost is small.
7. **Re-encoding.** Animated GIFs lose their animation. WebKit's WebP encoder is missing, so iOS uploads JPEG.
8. **Merge order.** `page-screen.tsx` is modified by W6. WP6 waits for that commit.
9. **Hostile pointer.** An editor could point the banner at another upload whose key they know. The mime list and the 8 MiB cap bound the damage. Inline media has the same risk.

## Open questions for the user

1. **The pointer is in `docsStore`, not in the `Y.Doc`.** The task text said that the pointer of page media lives in the `Y.Doc`. Design 2 keeps the banner pointer in a row envelope and the decrypted pointer, with its file key, in `docsStore` (memory only, as `messagesStore`). It is still E2EE: Takusen sees no byte, key or mime. CLAUDE.md gets an exception line. Design 1 (the `Y.Doc` `meta` map) is the alternative. It is safe too, but sub-pages must load the root page's whole doc.
2. **One banner per top-level page, or one per channel.** The plan gives each top-level page its own banner. A channel with several top-level pages then has several banners, not one "channel banner".
3. **A move of a page with a banner under another page.** The plan clears the banner and gives no warning. Other choices: Takusen refuses the move (409 `PageHasBanner`) until the banner is removed, or "Move to…" shows a confirm line ("The banner of this page will be removed"). The confirm line touches W6 files (`page-actions.tsx`, `page-move.ts`) and `use-page-tree-actions.ts`.
4. **Re-encode before upload.** WebP (JPEG on iOS), at most 2048 px wide. This removes EXIF and GPS data, and it also removes GIF animation.

**Decisions for the first build** (the user reviews them in the PR):

1. Keep the row envelope (Design 2). The decrypted pointer is in memory only, as in `messagesStore`. WP4 adds the CLAUDE.md exception line.
2. One banner per top-level page, as planned.
3. "Move to…" shows a confirm line when the page has a banner: "This removes the banner of <page>." The move then clears the banner as planned. This work starts after W6 commits, so it may edit `page-actions.tsx`, `page-move.ts` and `use-page-tree-actions.ts`.
4. Re-encode before upload, as planned. A GIF becomes a still image.

**Added to the same build** (user requests during the build):

- **Page title field.** The page header gets an inline title field on desktop and mobile, for users who may edit the page. It uses `docsService.renamePage` (the title is a page envelope). Enter or blur saves. Escape cancels. The field clears "Untitled" on focus, keeps `MAX_PAGE_TITLE_BYTES`, and has at least a 16 px font on mobile. Users who may not edit see plain text.
- **Unpin.** The page actions sheet (`components/docs/page-actions.tsx`, the mobile "⋯") gets "Pin channel to tabs" / "Unpin channel from tabs" for the page's pages channel (`pinTab` / `unpinTab` in `stores/tabsStore.ts`). Holding a tab in the mobile tab strip must open a menu with Unpin on iOS, and each tab also gets a visible button path to unpin.
