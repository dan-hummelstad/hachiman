# Arc redesign: new features plan

**Status: plan.** Base: `main` at `a687198`. This plan covers each element of the Pencil frame **Final** that main does not have. `docs/arc-redesign-plan.md` is the parent plan: it restyles what exists and names the slot where each feature here plugs in (its §6 and §7). When a feature changes a wire shape, the same PR updates `docs/gateway-protocol.md`. When it changes `pkgs/hachiman-crypto/src/api.ts`, the same PR updates contract §12.

## 1. Rules

- **E2EE first.** The server sees no content (contract §12). A feature that needs the server to read content is rejected or changed. Names that are plaintext today (guild, channel, page tree shape, topic) set the line: a new name at that level (thread name, event title) is plaintext too. Anything that is content (reactions, page labels, previews) goes inside an envelope.
- **Local before synced.** A per-user preference that only one device needs (tabs, favourites, notification levels) is stored on the device first (`zustand/middleware` persist, per account). Sync across devices is a later step and is listed as such.
- **One feature, one PR stack,** with its contract change, its Takusen, gateway and client parts, its UI slot, its tests, and its `?preview` fixture data.
- **No speculative parts.** Each item lists only what the mocks show.

## 2. Tiers

| Tier | Features | Why |
|---|---|---|
| 1: needed for the redesign | N1 pinned tabs, N2 back and forward, N3 sidebar states, N4 space bar tint, N5 quick switcher, N6 favourite DMs, N7 read state and unread, N11 replies, N15 role groups | The mocks are built around them. Without them the new layout has empty slots in every screen |
| 2: shown in the mocks, contained | N8 inbox, N9 notification levels, N10 reactions, N13 pinned messages, N14 guild events, N16 custom status, N17 call timers, N21 page additions, N24 audio waveform, N25 profile banner, N26 verified date | Each one is a small, separate change |
| 3: separate projects | N12 threads, N18 watch a stream, N19 camera, N20 DM calls, N22 bots and embeds, N23 blocking | Each one needs its own design doc first. The redesign does not wait for them |

## 3. Tier 1

### N1 Pinned tabs (the top tab bar)

**Mocks:** every screen with the shell. B5 ("A channel that is not pinned … no tab lights up. The start of the channel offers a Pin to tabs action"), B8 ("The standup tab is pinned, so it lights up"), C1, E2, E3, the sidebar behaviour board (item 5: "Pinned tabs stay on top").

**What it is.** Arc's pinned tabs, not browser tabs. The bar is a fixed, ordered list of shortcuts across all guilds and DMs. A tab lights up when its target is the open view. Else no tab is lit. Opening something that is not pinned does not add a tab.

- **Targets:** text channel, voice channel, pages channel or one page, DM or group DM, thread (N12, later).
- **Tab content:** the guild crest (small guild icon) on the left, the type icon in its feature colour, the name, then one state mark: a white dot for unread, a coral count for mentions (N7), green voice bars when your call is in that voice channel.
- **Actions:**
  - Click opens the target.
  - The active tab shows "✕", which unpins it.
  - Drag reorders (`@dnd-kit`, already installed).
  - "+" at the end opens the quick switcher (N5) in "pin" mode.
  - The pin glyph at the start pins or unpins the open view.
  - "Pin to tabs" in the channel intro, the channel and DM context menus, and the page header.
  - `⌘1`–`⌘9` open tab 1–9.
- **Overflow:** tabs shrink to a minimum width (icon and crest), then the bar scrolls.
- **Clean-up:** a tab whose target is gone (channel deleted, guild left, no VIEW_CHANNEL) is removed when the guild cache shows that.

**Data.** `stores/tabsStore.ts`: `tabs: TabTarget[]`, persisted per account (`hachiman:tabs:<userId>`). `TabTarget = { kind: 'channel' | 'page' | 'dm'; id: string; guildId: string | null; pageId?: string }`. The voice and pages cases are channels. The store reads the type from `channelStore`. No server change.

**UI.** New `components/shell/tab-bar.tsx` in the tab row of the shell (redesign Phase 1). The row is the Electron drag region. Tabs and buttons are `no-drag`.

**Tests.** Store: pin, unpin, reorder, clean-up on channel delete, "is active" for each kind.

**Later.** Sync across devices: store the list encrypted to the user's own devices (the identity backup path, §12.17), not as plaintext on the server. That needs a design note, not part of this item.

### N2 Back and forward

**Mocks:** the sidebar controls row (B1), and in the tab bar when the sidebar is hidden (behaviour board item 6).

- `navStore` gets an in-memory history: `past: View[]`, `future: View[]`, and `back()`, `forward()`. `View` is what the shell shows: a channel, a page, the DM home, a DM, or a settings page. Each navigation pushes onto `past` and clears `future`. Not persisted.
- Shortcuts: `⌘[` and `⌘]`, the mouse back and forward buttons (`auxclick` buttons 3 and 4), and the Electron `app-command` events `browser-backward` and `browser-forward` on Windows. Electron forwards these through the existing preload bridge only if the renderer does not get them already. Check this first. Add an IPC channel only if needed.
- A view whose target is gone is skipped.
- **Tests:** push, back, forward, skip of a missing target, cap at 50 entries.

### N3 Sidebar states: docked, hidden, shown on hover

**Mocks:** sidebar behaviour board (all seven items and the spec table), H5 (Appearance › Sidebar).

The behaviour, from the board's spec table:

| Item | Rule |
|---|---|
| Toggle | `⌘S` or the sidebar button. The choice is remembered per window |
| Reveal | pointer in the left 8 px, slide in over 150 ms |
| Hide | 300 ms after the pointer leaves, not while a menu, a drag or a text field in the sidebar is active |
| Esc | hides a revealed sidebar |
| Dialogs | open above everything, a revealed sidebar closes first |
| Narrow windows | below 1100 px the sidebar starts hidden |

- **Hidden:** the content card takes the window width (8 px inset). The sidebar toggle, back and forward move to the start of the tab bar, and search and inbox to its end. On macOS the traffic lights move there too (`BrowserWindow.setWindowButtonPosition`, through a new IPC call. This is a seam method: `IPlatformService`, both hosts, the preload bridge and `apps/hachiman-electron/src/shared/ipc.ts`). The voice dock floats in the bottom-left corner of the content card, and the composer shifts right to clear it.
- **Revealed:** the sidebar slides over the content with a shadow. Nothing in the content moves. The toggle reads "dock".
- **Edge strip:** a faint 8 px strip marks the hot zone while hidden.
- **State:** `prefsStore.sidebar: 'docked' | 'undocked'`. "Per window" means per device today: there is one window. A transient `revealed` flag lives in component state.
- `⌘S` must not fire inside the composer or the page editor when they use it. Check Milkdown's bindings first.
- **Tests:** the hide guard (menu open, drag, focused field), the narrow-window default.

### N4 Space bar and guild tint

**Mocks:** every shell screen. "Each guild tints the window." B8: "Switching space to Lattice Labs swaps only the middle of the sidebar."

- The space bar itself is a restyle (redesign Phase 1).
- **Tint.** The mocks have one tint per guild (Night Owls violet, Lattice Labs teal, Dog-ear Club orange, home slate). The guild has no colour field, and G1 has no colour picker. Compute the tint on the client: the dominant hue of the guild icon (decode the icon in a canvas, take the most common saturated hue). With no icon, hash the guild id into the palette of feature hues. Mix the hue into `surface/window` at a fixed lightness per theme, so the contrast stays the same. Cache by icon key.
- Icons are plaintext files (§4 Files), so the client can read them. No server change.
- The DM space uses `tint/home`.
- **Tests:** the hue picker on three fixture icons, the hash fallback.

### N5 Quick switcher ("Search or jump to… ⌘K")

**Mocks:** the search field at the sidebar top (all shell screens), the "+" of the tab bar.

- A popover (480 wide) with one input and one result list: channels, voice channels, pages (titles from `docsStore`, already decrypted), DMs and people, across all guilds. Each result shows its type icon, its guild, and its unread state. Enter opens, `⌘Enter` pins (N1).
- **Message search is not part of this.** The server cannot search ciphertext. A local search index over decrypted messages is a separate design (encrypted store, size limits, history that the device never loaded). Do not show a "messages" section.
- Matching: case-insensitive substring, then rank by recent use (from N2 history). No library: the lists are small.
- `⌘K` opens it from anywhere except a modal dialog.

### N6 Favourite DMs

**Mocks:** the "DIRECT MESSAGES" strip of five avatar tiles at the sidebar top, with mention badges and presence (all shell screens). E3: "the favourite tile and the sidebar row still do [light up]".

- `prefsStore.favouriteDms: string[]` (channel ids), persisted per account. "+" opens the people picker. Right-click a DM row or tile: "Add to favourites" or "Remove".
- Tile: avatar 46, presence dot, mention badge (N7), group DM shows stacked avatars. The tile of the open DM gets the selected ring.
- Hide the strip when the list is empty and show "+" in the section label only.

### N7 Read state and unread

**Mocks:** bold channel rows with the left pip (B1 `#lfg`), the coral mention count, the NEW divider in the transcript, the tab dots and counts, the space-bar badge (Dog-ear Club "3"), the DM tile badges.

Main has no read state. This is the largest Tier 1 item.

**Server (metadata only).** The server knows each message id, its channel and its time. It can store where the user has read to and count unread messages. It cannot see mentions.

- Schema: `read_states (user_id, channel_id, last_read_message_id, updated_at)`, primary key `(user_id, channel_id)`, cascade on both. One migration (stack it: `pnpm -F @hachiman/takusen db:generate`).
- REST: `POST /channels/:id/ack { messageId }`. VIEW_CHANNEL. Only moves forward (compare the snowflake or `created_at`). Rate limit like typing.
- Gateway: Takusen publishes `READ_STATE_UPDATE { channelId, lastReadMessageId }` to `user:{id}`, so the other sessions of the user clear the badge.
- READY: `readStates: { channelId, lastReadMessageId, unreadCount }[]` for the channels the user can view, with `unreadCount` capped at 100. Also the last message id per channel, so a channel with no read state can show "unread".
- Contract: §1 (entity), §3 (table), §4 (route), §6 (event, READY field). Gateway: the READY field is filled in Go from Postgres. Go tests for the visibility filter (no read state for a channel without VIEW_CHANNEL).

**Client.**

- `stores/unreadStore.ts`: per channel `{ lastReadId, unread: number, mentions: number }`. Selectors with the module-level empty constants rule.
- **Unread:** from READY, then +1 on each `MESSAGE_CREATE` from another user in a channel that is not open and focused.
- **Mentions:** counted on the client only. Live: `hachiman.ts` already decrypts every `MESSAGE_CREATE` and checks mentions (the mention sound). Increase `mentions` there. After a restart: for each channel with `unread > 0` (at most 20 channels, newest first), fetch the messages after `lastReadId` (at most 50), decrypt, and count mentions. Do not send mention user ids in plaintext to the server: that leaks who talks to whom.
- **Ack:** when the channel is open, the window has focus, and the last message is in view, send `ack` (debounced 1 s).
- **NEW divider:** above the first message after `lastReadId`, as it was when the channel opened. It stays until the channel is left.
- **Where it shows:** channel rows (bold and pip, coral count for mentions), category (nothing), space bar (guild dot, sum of mentions), tabs (N1), DM tiles and rows, the window title and the dock badge (Electron `app.setBadgeCount`, through the existing platform seam if present, else add one).

**Tests.** Takusen: ack forward-only, READY counts, the cap. Client: the store reducers, the restart mention pass with a fake message list.

### N11 Replies

**Mocks:** B1 (the quoted line above Juni's message with a link curve), the reply button in the hover toolbar.

- The data exists: `MessageContent.replyTo` (a `clientMsgId`) is in the envelope and is always null today.
- Composer: "Replying to <name>" bar with ✕. Send sets `replyTo`.
- Row: a one-line preview of the target from the store (author colour, text). Click scrolls to it. When it is not loaded, fetch around it or show "Original message not loaded".
- A reply to a message that cannot be decrypted shows "Encrypted message".
- No server or contract change. Check that §12.8.1 already documents `replyTo`. If not, add it.

### N15 Role groups in the member list

**Mocks:** B1 (CAPTAIN — 1, SHOTCALLERS — 2, SQUAD — 5, BOTS — 1, OFFLINE — 3), G2 ("Show as its own group in the member list"), B10 (a guild with no such roles groups by online and offline).

- Schema: `roles.hoist boolean not null default false`. One migration.
- `Role.hoist` in `pkgs/hachiman-client/src/types.ts` and contract §1. `PATCH /guilds/:id/roles/:roleId` takes `hoist`. MANAGE_ROLES. The role event already carries the role.
- **Signed admin actions (§12.16):** `hoist` changes no permission. A PATCH with only `hoist` (or `color`, `name`) needs no `X-Hachiman-Signed-Action`. State this in §12.16 next to the existing rule for `permissions`.
- Member list: online members grouped by their highest hoisted role (by position), each group "NAME — n" with the role colour square. Online members with no hoisted role go in "ONLINE — n". All offline members go in "OFFLINE — n". Change `components/people/presence-sections.tsx` to take the groups.
- G2: the switch row.
- **Tests:** the grouping function (highest hoisted role, ties by position, offline last).

## 4. Tier 2

### N8 Inbox

**Mocks:** the inbox button with a red dot at the sidebar top (all shell screens), and in the tab bar when the sidebar is hidden.

- A popover with two tabs: "Mentions" (the messages that mention you, newest first, across channels) and "Unread" (channels with unread messages, grouped by guild, with "Mark read").
- Built from N7: the mention pass keeps the message ids it counted. Mark read sends `ack`.
- The red dot shows when there is any mention.
- Not a server feature. The E2EE device inbox (`ds-transport.ts`) is unrelated. Name the UI parts `MentionsInbox` to avoid confusion.

### N9 Notification levels and "Follow"

**Mocks:** the bell in the channel header (B1), "Notification settings" in the guild menu (B4), "Follow" in a read-only channel (B7).

- Levels per channel and per guild: all messages, mentions only (default), nothing. Plus a guild-level "mute".
- Stored in `prefsStore` per account. It controls the sounds (`SoundService`, already reads `prefsStore`), the unread pip and count visibility (N7), and the desktop notification if one exists.
- "Follow" sets the channel to "All messages" and shows "Following". Decision 6 of the redesign plan: no cross-guild follow.
- Sync across devices: later, same note as N1.

### N10 Reactions

**Mocks:** B1 (two reaction chips, one selected by you, and the "add reaction" chip), the react button in the hover toolbar.

- **Encrypted.** A reaction is content. It is a message with a new envelope content kind `reaction { target: clientMsgId, emoji: string, remove: boolean }`. The crypto API `kind: 'message' | 'edit'` becomes `'message' | 'edit' | 'reaction'` (`pkgs/hachiman-crypto/src/api.ts`, `encodeContent` and `decodeContent`, and contract §12.8 in the same PR).
- **Server:** no change. A reaction is a normal message row to the server, which cannot tell it apart. A side effect: reactions count toward history pages. This is acceptable, because the transcript fetch already pages.
- **Client:** `messagesStore` folds reaction messages into a `reactions` map on the target (`emoji → Set<userId>`), last event per (user, emoji) wins, by sender order. Reaction messages do not render as rows and do not count as unread (N7). The client cannot tell the server, so the server's unread count includes them. Document that the count is an upper bound.
- **Permission:** SEND_MESSAGES covers it, because the server cannot check a separate permission.
- Emoji picker: the composer's emoji picker, reused.
- **Tests:** crypto encode and decode round trip, store fold (add, remove, re-add, out of order).

### N13 Pinned messages

**Mocks:** the amber pin button with a count in the channel header (B1: "4").

- Schema: `channel_pins (channel_id, message_id, pinned_by, pinned_at)`, primary key `(channel_id, message_id)`, cascade on message delete.
- REST: `GET /channels/:id/pins` (VIEW_CHANNEL and READ_MESSAGE_HISTORY), `PUT` and `DELETE /channels/:id/pins/:messageId` (MANAGE_MESSAGES). Limit 50 per channel.
- Gateway: `CHANNEL_PINS_UPDATE { channelId, guildId }` to the channel's viewers.
- Contract §3, §4, §6.
- UI: a popover (480) with the pinned messages, decrypted by the normal path (`message-decrypt.ts`), "Jump" and "Unpin". "Pin message" in the message "more" menu.
- The server learns which message ids are pinned. It learns no content.

### N14 Guild events

**Mocks:** the amber event row under the guild header ("Scrims · Thu 21:00 · 5 going", "Ch. 1–7 talk · Wed 14 · 3 going"), the `calendar-heart` icon, the gold maintenance embed is a bot post (N22), not an event.

- **Plaintext metadata,** like a channel topic: title, start, optional end, optional voice channel. State this in contract §12 (the list of what the server sees).
- Schema: `guild_events (id, guild_id, channel_id null, title, starts_at, ends_at null, created_by, created_at)` and `guild_event_rsvps (event_id, user_id, created_at)`. Migration.
- REST: create, update, delete (new permission MANAGE_EVENTS: a free bit below 31, in both `permissions.ts` and `permissions.go`, which `sync_test.go` compares), list (VIEW_CHANNEL on the guild), `PUT` and `DELETE /events/:id/rsvp` (any member).
- Gateway: `GUILD_EVENT_CREATE`, `_UPDATE`, `_DELETE`, `GUILD_EVENT_RSVP` to `guild:{id}`.
- UI: the event row in the sidebar shows the next event in the next 7 days, with "n going". Click opens a popover with the details, "Going" toggle, and the voice channel link. "Create event" in the guild menu (by permission).
- B10 says "The topic's deadline becomes the guild's gold event row". Do not parse topics. A member creates the event.

### N16 Custom status

**Mocks:** member and DM rows ("5am, watching the VOD", "Reading chapter 6").

- A short text (at most 64 characters) and an optional end time, set from the space-bar avatar menu.
- Plaintext to the people who share a guild or a DM with you, like presence. It is user-chosen and shown as such.
- Store in Redis with the presence (`presence:{userId}`), not in Postgres. The gateway includes it in `PRESENCE_UPDATE` and READY presences. `Presence.customStatus?: string`.
- Contract §1, §5 (Redis key), §6. Gateway Go change. Client type and store.
- Activity lines from voice state ("Speaking in Lounge", "In Lounge · Night Owls") exist as data and are part of the redesign (Phase 4). Show the guild name of another guild only if the viewer shares that guild.

### N17 Call timers

**Mocks:** the dock timer and the channel-row timer ("1:24:07").

- **Dock timer:** the time since you joined. Client only.
- **Channel timer:** the time since the call started. The client needs the start. Add `joinedAt` to `VoiceState` (the gateway writes it into the Redis voice state on join). The call start is the oldest `joinedAt` of the current participants. Contract §1, §5, §6. Gateway Go change and tests.

### N21 Page additions

**Mocks:** C1, the "Scrim playbook" card in B1, the Members | Pages switch with a count in text channels.

1. **Open a page beside any channel.** The Pages tab of the right column in a text channel lists the guild's pages that the user can view (all pages channels), with search. Opening one shows it in the 540 column. The page belongs to its own pages channel. `DocProvider` already works per page, so this is UI only. The count on the tab is the number of page links in the open channel's loaded messages. If that is not useful, show no count.
2. **Page link card in chat.** A message that has a page link (the existing page link format) shows a square card: page icon, title (decrypted), "Page in #channel · edited <time>", "Open" (opens beside). UI only.
3. **Page activity in chat.** "yuki.h edited RFC: pages channels · 2 changes · View". The editing client posts it as a message with a new content kind `page_activity { pageId, changes }`, batched to at most one per page per 10 minutes per user. This is a crypto API change (`kind`) and §12.8 and §12.20 changes. Reconsider before building: the same can be a local derivation from `PAGE_UPDATE` events if the channel is open, which needs no wire change but shows nothing to people who were away. Recommended: the message kind.
4. **Page labels** ("RFC", "Draft"). Labels are content: store them in the `Y.Doc` metadata map, so they are encrypted with the page. Editor UI: chips under the title, a small "add label" menu.
5. **Header and footer:** the awareness avatars, outline, copy link, pop out (Electron: new window is out of scope, so open in the browser host's new tab only), "Saved · end-to-end encrypted", the word count. UI only.

### N24 Audio waveform

**Mocks:** B1 (the audio card with play, waveform and "0:04 / 0:12").

- Decode the decrypted blob with Web Audio (`decodeAudioData`), downsample to about 48 bars, cache by attachment id in memory. Play with an `<audio>` element on the decrypted object URL (`use-decrypted-blob.ts`). UI only.
- Voice-message recording is not in the mocks. Do not add it.

### N25 Profile banner

**Mocks:** E2, E3 (coloured banner on the profile column), H1.

- No new data: use the dominant colour of the avatar (the N4 helper). A user banner upload is not in the mocks.

### N26 Verified date

**Mocks:** E3 ("Verified 2 Oct", "You compared safety numbers on 2 Oct"), E5 ("You verified marlowe on 2 Oct").

- `TrustInfo.verifiedAt: string | null` in `pkgs/hachiman-crypto/src/api.ts`, set by the Worker in `setVerified` and `verifyQr`, kept in the encrypted store. Contract §12 change in the same PR (CLAUDE.md rule). Older verifications have `null`. The UI then says "Verified" without a date.

## 5. Tier 3: separate projects

Each of these needs a design doc (like `docs/pages-channels-plan.md`) before code. The redesign phases keep their slot empty until then.

### N12 Threads

**Mocks:** the sky "Bracket seeding" tab, the threads button with "3" in the header, the thread button in the hover toolbar.

Design questions for the doc:
- **Group.** A thread uses the MLS group of its parent channel (the `public_set` group for a public channel, the channel group otherwise). Public channels already share one group, so the DS supports more than one channel per group. A thread then needs no new group, no new membership, and no new key work.
- **Shape.** A `thread` channel type with `parentId` = the text channel and the plaintext name (as channel names). Permissions come from the parent. Archive after inactivity.
- **Start message.** The thread links the parent message by `clientMsgId` inside the first thread message's envelope, not in plaintext.
- **Contract:** §1, §3, §4, §6 (`THREAD_CREATE`, `THREAD_UPDATE`), the gateway visibility filter, and §12.6 (the group rule).

### N18 Watch a stream

**Mocks:** D2 ("Join voice … Watch stream"), E1 (Active now: "Watch"), the live card in the members column.

- To decode the stream, the viewer must be in the call's MLS group (§12.10). So "watch" is a join: a voice join with the mic off and the viewer's own tracks not sent, shown as "watching" in the roster. It moves your current call, as a join does.
- Questions: Does a watcher count as a participant for the call code? Does the SFU forward audio to a watcher (yes, the stream's audio is call audio)? How does the roster show watchers? Media and client changes: use the `webrtc-reviewer` agent.
- The thumbnail rule is decision 4 of the redesign plan.

### N19 Camera

**Mocks:** the camera button in the dock (all screens) and the call bar (D1).

- A third track per client. Today each client has a mic track (m-line 0) and a screen track (m-line 1), and `VoiceConnection.setScreen` swaps the screen track with no renegotiation (§8). A camera needs a new m-line, a new stream id (`camera-<userId>`), SFrame track 2, an `selfVideo` voice state, and grid tiles that show video.
- High risk in `pkg/media/sfu.go`, `ssrc_pool.go`, `voice.go` and `voice.ts` (renegotiation, SSRC pool). `webrtc-reviewer` is required. Look for (key, CTR) reuse across the new SFrame track.

### N20 DM calls

**Mocks:** the call and video buttons in the DM header (E2, E3), "Call" on the People rows (E1), the "Incoming call" sound (H6).

- Voice today is per guild (`VoiceState.guildId`, rooms per guild channel, placement by guild region). A DM call needs a room per DM channel, a ring event to the other members (`CALL_RING`, ring timeout, decline), a region choice without a guild, and the voice MLS group for the DM members.
- Questions: gateway placement without a guild, the incoming call UI on every session of the user, what happens when you are already in a guild call.

### N22 Bots and embeds

**Mocks:** vexbot with the `BOT` tag, the "SCHEDULED MAINTENANCE" and "PATCH NOTES" embed cards, the BOTS role group.

- A bot under E2EE is a user with a device, keys and MLS membership. It must run the crypto library. That is a platform (bot accounts, a bot SDK on `@hachiman/crypto/ds`-like Node entry, a token type, rate limits).
- An embed is a new content kind (`embed { title, body, colour, fields }`) inside the envelope.
- Out of scope for the redesign. Do not render the `BOT` tag or embed styles until this project exists.

### N23 Blocking

**Mocks:** E1 ("Blocked 0" in the People tabs).

- Server: `user_blocks (user_id, blocked_user_id)`. A block refuses new DMs from the blocked user. Client: hide their messages behind "Blocked message" in shared guilds. The decrypt still runs (MLS needs it).
- Not needed for the redesign. Remove the "Blocked" tab from the People view until this lands.

## 6. Order

```
Redesign Phase 0 ─ Phase 1 ─────────── Phase 2 ─── Phase 3 ──────── Phase 4 ─────────── Phase 5 … 9
                     │                    │           │                │                   │
                     ├ N2 history         ├ N4 tint   ├ N7 read state  ├ N15 role groups   ├ N17 timers
                     ├ N3 sidebar states  ├ N6 favs   ├ N11 replies    ├ N16 custom status ├ N26 verified date
                     ├ N1 tabs            │           ├ N9 levels      ├ N21 pages         └ N18, N19, N20 (own docs)
                     └ N5 switcher        │           ├ N10 reactions  └ N25 banner
                                          │           ├ N13 pins
                                          │           ├ N8 inbox (after N7)
                                          │           └ N24 waveform
                                          └ N14 events
```

- **Dependencies:** N1 needs N7 for its badges (it ships without them first). N8 needs N7. N5 uses N2 for ranking (it ships without it first). N3 needs Phase 1 (the tab row). N12 adds a tab kind to N1.
- **Wire changes, by contract section:**

| Feature | §1 types | §2 permissions | §3 schema | §4 REST | §5 Redis | §6 gateway | §12 E2EE |
|---|---|---|---|---|---|---|---|
| N7 | ✓ | | ✓ | ✓ | | ✓ (+ READY) | |
| N10 | | | | | | | ✓ §12.8 |
| N13 | | | ✓ | ✓ | | ✓ | |
| N14 | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ (what the server sees) |
| N15 | ✓ | | ✓ | ✓ | | | ✓ §12.16 (note) |
| N16 | ✓ | | | | ✓ | ✓ | |
| N17 | ✓ | | | | ✓ | ✓ | |
| N21 (3) | | | | | | | ✓ §12.8, §12.20 |
| N26 | | | | | | | ✓ (api.ts) |

All others are client only.
