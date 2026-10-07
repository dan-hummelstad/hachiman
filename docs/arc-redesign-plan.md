# Arc redesign of the chat app: execution plan

**Status: plan.** Base: `main` at `a687198` (invites with history, invite limits, pages for new members). Source of the design: the Pencil file `pencil-new.pen`, frame **Final** (`X9RV1V`). The frame has 48 screens, a component kit, foundations and a sidebar behaviour board. The features that the app does not have yet are in `docs/arc-new-features-plan.md`. This plan tells where each of them connects.

When this plan is done, `docs/ui-redesign.md` describes the Arc design, and this plan and the feature plan are the history of the work.

## 1. What the design is

Header of the Final frame: "Arc sidebar. Square structure. Rounded interaction."

- **Arc sidebar.** One sidebar (280 px) holds everything that is not content: window controls, search, favourite DMs, the guild (or DM, or settings) navigation, the voice dock and a **space bar** at its foot. The space bar replaces the guild rail. The sidebar can be docked, hidden, or shown on hover (`docs/arc-new-features-plan.md` N3).
- **Pinned tabs.** A tab bar (48 px) runs across the top of the content area. It holds pinned channels, voice channels, pages, DMs and threads across all guilds (N1).
- **Content card.** The content sits on one card, inset 8 px from the right and bottom edges of the window, with a 1 px border. The window behind it is a wallpaper that each guild tints (N4).
- **Square is structure.** Windows, panels, columns, cards, dialogs, popovers, tables, banners, notices, embeds, attachments and system tags have radius 0.
- **Rounded is interaction.** Buttons, inputs, search, composer, tabs, toggles, checks, radios, chips, reactions, selected and hovered rows, badges and avatars are rounded.
- **Colour marks the feature.** Accent violet for selection and actions. Green for voice, amber for events, violet for pages, sky for threads, coral for live and errors, teal for bots.
- **Settings use the sidebar.** Channel, guild and user settings replace the middle of the sidebar with their section list. The page shows in the content card. Nothing covers the window. Dialogs are only for actions (create, invite, leave, delete, verify, link).

## 2. Foundations (from the Final frame)

### 2.1 Tokens

The `.pen` file defines every value as a variable with a dark and a light value. Port them 1:1 into `apps/hachiman/src/assets/main.css`, with the same names in CSS form (`surface/window` → `--surface-window`). Map the shadcn names that the primitives use (`--background`, `--card`, `--primary`, ...) onto them, so that the primitives change once.

| Group | Tokens | Dark → Light |
|---|---|---|
| surface | window, content, panel, raised, sunken, hover, selected, scrim | `#0E0F15`/`#F7F7FB`, `#1D1E28`/`#FFFFFF`, `#17181F`/`#F8F8FB`, `#262836`/`#F1F1F6`, `#0F1016`/`#FFFFFF`, `#FFFFFF0F`/`#23204A0D`, `#7B6CFF2B`/`#6B5BF52B`, `#05060AB8`/`#16151F66` |
| line | hairline, strong, focus | `#2A2C3B`/`#E3E3EC`, `#363849`/`#DCDCE6`, `#7B6CFFB3`/`#6B5BF599` |
| text | primary, secondary, tertiary, disabled, on-accent | `#F3F4FA`/`#16151F`, `#B6B9CE`/`#4E5066`, `#80839A`/`#6E7088`, `#5C5F76`/`#9C9EB2`, `#FFFFFF` |
| accent | primary, text, tint | `#7B6CFF`/`#6B5BF5`, `#C9C2FF`/`#5B4AE8`, `#7B6CFF2B`/`#6B5BF52B` |
| feature | voice, event, page, thread, danger, activity, bot (+ `-text` variants) | see the `.pen` variables |
| status | online, idle, dnd, live, offline | green, amber, coral, violet, grey |
| tint | one per guild in the mocks, plus `home` | replaced by a computed tint (N4) |
| role | captain, shotcaller, squad, bot | mock data only: roles keep their stored colour |
| space | 1–10 | 4, 8, 12, 16, 20, 24, 32, 40 px |
| radius | structure, check, control, option, pill | 0, 4, 8, 10, 999 |

The `tint/*` and `role/*` variables are mock data. Do not port them as tokens.

### 2.2 Type

- **Figtree** for all UI and chat text. **IBM Plex Mono** for keys, safety numbers, codes, invite codes and token names.
- Scale: display 48/800/-1, page title 26/800, section title 22/800, heading 16/800, body 15/500/1.45, UI label 14/600, meta 12/500, section label 11.5/800/+0.7 uppercase, mono 15/600.
- The chat is no longer monospace. This reverses the "transcript" signature of the current spec.
- Vendor the fonts as woff2 in `apps/hachiman/src/assets/fonts/`, as the current fonts are. The CSP (`apps/hachiman-electron/src/main/csp-policy.ts`, `apps/hachiman-browser/csp.ts`) allows no font host. Remove the IBM Plex Sans and Geist Mono files.

### 2.3 Icons

Lucide (already installed as `lucide-react`), stroke 1.5. Sizes: 16 px in rows and controls, 18–20 px in headers and voice controls, 13–14 px in chips. An icon takes the colour of its feature, else the text colour. The iconography board in the frame lists the icon for each use. Use that list as the mapping.

### 2.4 Layout metrics (window 1440 × 900)

| Region | Size |
|---|---|
| Sidebar | 280 wide, padding 10 |
| Pinned tab bar | 48 high, tabs 34, gap 4 |
| Content card | inset 8 right and bottom, 1 px border |
| Chat header | 56, padding 0/12/0/20 |
| Composer | 52, area padding 0/16/12/16 |
| Members column | 252 (page column 540) |
| Message | avatar 40, gap 14, padding 6/10 |
| Channel and category row | 30, padding 0/8/0/10 |
| Voice participant row | 26, indent 34 |
| Event row | 38 |
| DM favourite tile | 46 |
| Voice dock | about 93, buttons 32 |
| Space bar | 40, guild icons 26 |
| Dialog | 500–640 wide, header 16/22, body 18/22, footer 14/22 |
| Popover | 480 wide |
| Settings page | header 76, content padding 28 |
| Hit target | 32 minimum |

Avatars become circles (they are squares now). The presence dot is a circle on the avatar corner.

## 3. Where main is now

The inventory of `apps/hachiman/src` on `main`:

- **Shell:** `components/shell/shell.tsx` is a fixed CSS grid `72px 240px 1fr [240px]`: the rail (`server-icon-rail.tsx`), the channel sidebar (`channel-sidebar.tsx`), the main pane and the member list (`member-list.tsx`). `WindowStrip` (28 px) clears the macOS traffic lights. There are no routes. `stores/navStore.ts` holds `guildKey` (`'@me'` for DMs) and `channelByGuild`. `stores/dialogStore.ts` opens one dialog at a time.
- **Style:** Tailwind 4.3, tokens in `assets/main.css`, `--radius: 0`, hard offset shadows, amber accent, IBM Plex Sans and Geist Mono, square avatars.
- **Settings:** full-window overlays (`components/settings/settings-layout.tsx`, `side-list.tsx`).
- **Onboarding:** `components/security/onboarding.tsx` is a full screen in front of the shell (`CryptoGate`).
- **Already built, needs a restyle only:** DM home and DM list, pages split (react-resizable-panels), voice room and stream grid, verify call, failed send with Retry/Delete, decrypt failures, read-only composer, channel intro, guild menu, all guild and channel dialogs, channel settings (overview, permissions), guild settings (overview, roles, members, invites), user settings (account, devices, recovery key, security log, appearance, voice and audio), all set-up, recovery, link and key-change dialogs, cozy and compact transcript, light and dark themes, the `?preview` mode.

## 4. Decisions

The mocks do not show everything that main does, and some mocks show things that E2EE does not allow. These decisions apply to the whole plan.

1. **No placeholders.** A redesign phase ships the elements whose feature exists. An element that needs a feature from the feature plan appears in the PR of that feature. Examples: the tab bar (N1), unread pips and badges (N7), the inbox button (N8), reactions (N10), the threads and pins header buttons (N12, N13), the event row (N14), the camera button (N19), the DM call buttons (N20). Until then, the region keeps its size and stays empty, or the control is not rendered. `docs/ui-redesign.md` already has this rule ("do not add placeholders").
2. **Invites with history stay.** F3 (Invite people) and G4 (Guild settings · Invites) do not show the "include history" choice that main has (`docs/invite-history-plan.md`). Keep it. Put it as a toggle row under the two limit selects, in the style of the "Private channel" row of F5. Keep the history badge in the invite table of G4.
3. **Onboarding is a dialog over an empty window.** I1–I5 show the set-up dialogs over a live, decrypted chat. Before the device has keys, there is no decrypted content. `CryptoGate` keeps the gate. It renders the window frame (wallpaper, empty sidebar chrome, empty content card) with the set-up dialog on the scrim. The dialog styles of I1–I5 apply. The same dialogs open from settings over a live window (`security-setup-dialog.tsx`, already present).
4. **No stream thumbnail for people outside the call.** D2, E1 and the members column show a frame of quill's stream to people who are not in the call. SFrame keys are only in the call's MLS group (contract §12.10), so a non-member cannot decode a frame, and the server must not get a frame in plaintext. Show the thumbnail only to members of that call. Outside the call, the card shows the streamer's avatar on the live-coral tint with "LIVE · n watching". "Watch stream" is N18.
5. **Trust is per user.** E2 and E4 show "Not verified" per device. In contract §12.5 the user verifies the master key, and each device chains to it. The device rows show the device fingerprint, and the badge shows the user's trust. "Verified 2 Oct" needs a `verifiedAt` (N26).
6. **"Follow" in a read-only channel** sets the channel's notification level to "All messages" (N9). Cross-guild following is not possible: the server cannot copy ciphertext into another guild's group.
7. **Announcement channels.** B7 shows a megaphone channel. Do not add a channel type. A text channel in which `@everyone` has no SEND_MESSAGES shows the megaphone and the "Read only" chip. The data exists (`chat-body.tsx` already checks SEND_MESSAGES).
8. **Restricted channels** (B9) need no new data: the chip and the intro card list the roles that have VIEW_CHANNEL through the overwrites.
9. **Electron chrome.** On macOS, keep `titleBarStyle: 'hiddenInset'`. Move the traffic lights into the sidebar's top row (`trafficLightPosition`) and start the sidebar controls after them. The tab bar is the drag region, and tabs and buttons are `no-drag`. When the sidebar is hidden, the traffic lights and the controls move into the start of the tab bar (N3). Remove `WindowStrip`. On Windows and Linux, keep the native frame.
10. **Mock data is not product data.** BOT tags, embeds, custom statuses, guild tints and role names in the mocks are examples. Ship what the data has (see the feature plan for each).
11. **The `?preview` fixtures follow the mocks.** Change the fixture to the mock cast (Night Owls with Captain, Shotcallers, Squad and Bots, then Lattice Labs, Dog-ear Club, and the users marlowe, Juni, ozzy, kestrel, yuki.h, quill, renata, petra_v, sable, tobias, wren, vexbot). Then each phase can be compared to its mock screen by screen.

## 5. Phases

Each phase is one PR or a small stack. Each phase is complete: typecheck, lint, the shared UI tests, and a screenshot pass in `?preview` (dark, light, compact) against the mock IDs that the phase names. Use the verify/run skill for the browser pass. The `webrtc-reviewer` agent reviews any phase that touches voice files.

### Phase 0: foundations

- Tokens, fonts, radii, focus ring and shadows in `assets/main.css` (§2). Remove the hard offset shadow and `--shadow-ink`. Popovers and the revealed sidebar get a soft shadow. Nothing else gets a shadow.
- Primitives in `components/ui/` to match kit "02 · Components":
  - `button`: variants primary, secondary, danger, quiet, voice (green), all radius 8.
  - `input`, `textarea`, `native-select` (chevrons-up-down), `switch` (pill), checkbox (radius 4), radio card (radius 10, feature colour per option, as in F5), keycap (`⌘K`, `Esc`).
  - chip, badge (pill, count), system tag (square: PAGE, LIVE, BOT, NEW, ENCRYPTED, KEY CHANGED, YOU), segmented control (Members | Pages), callout (info, caution gold, danger red, success green, all square).
  - `avatar`: circle, presence dot.
  - `dialog`: header icon tile (feature colour), title and subtitle, body, footer with the actions on the right. Scrim from `surface/scrim`.
- Rewrite `docs/ui-redesign.md` as the Arc spec: §1 and §2 of this plan plus the rules of each later phase.
- Update the `?preview` fixture (decision 11).
- **Done when:** the app runs with the new tokens and nothing is broken. The shell is still the old layout. Light and dark both pass a contrast check of text on surfaces.

### Phase 1: window frame and shell layout

- Replace the grid in `shell.tsx` with: wallpaper (the window), sidebar 280 on the left, and a content column (tab bar row 48, then the content card with an 8 px inset and a 1 px border). The content card holds header, body and the right column.
- Remove `server-icon-rail.tsx`. Its guild context menu moves to the space bar.
- New `components/shell/sidebar.tsx` with four slots, top to bottom: controls row, top block (search, favourites), middle (guild, DM or settings navigation), foot (voice dock, space bar).
  - **Controls row:** sidebar toggle, back, forward, inbox. Render only the controls that exist (decision 1): the toggle comes with N3, back and forward with N2, the inbox with N8.
  - **Space bar:** your avatar (opens user settings, ringed while they are open), the DM space, the guilds with their icon, the "+" (add guild). Selected guild has a ring. Unread uses N7.
- Electron chrome (decision 9): `apps/hachiman-electron/src/main/index.ts`, and remove `components/ui/window-strip.tsx` and the `insetTitleBar` uses.
- The wallpaper uses `surface/window` until N4 tints it.
- The right column keeps its current toggle and widths (252, page 540).
- **Mocks:** B1, B2, B8 (layout only).

### Phase 2: sidebar content

- **Guild header row:** crest, name, chevron. On the right: the lock (all guilds are encrypted) and the online count ("● 9"). Click opens the guild menu as a **popover attached to the sidebar** (B4), not a dropdown. Delete guild is set apart at the bottom in red. Reuse `guild-menu-items.tsx`.
- **Channel list:** categories (section labels with chevron and "+"), rows at 30 px. Selected row uses `surface/selected` and radius 8. On hover and when selected, the row shows the invite and settings icons (B1, F3). Pages channels show the `PAGE` tag. Read-only channels show the megaphone (decision 7). Restricted channels show the lock (decision 8). Keep the drag reorder and the collapsed state.
- **Voice channels:** green icon. Participant rows at 26 px, indent 34, with mute and deafen icons. `LIVE` tag for a streamer. The channel timer comes with N17.
- **Voice dock** (restyle `voice-connected-panel.tsx`): green tinted card, "Voice connected", channel and guild, own call timer (N17, client-only part), and five buttons: mic, deafen, camera (N19, hidden until then), share screen, disconnect (coral). The current quality indicator moves into a tooltip on the title. `nav-user.tsx` goes away: mic and deafen are in the dock, settings are on the space-bar avatar. When you are not in a call, the dock is not rendered.
- **DM space** (E1–E3): the middle shows a "Direct messages" header with "new message", a "People" row with the online count, and "CONVERSATIONS" with the DM and group DM rows (avatar, name, last message preview from the decrypted cache, `LIVE` tag). Reuse `DmList`.
- **Mocks:** B1, B4, B8, B9, B10, E1–E3.

### Phase 3: content (header, transcript, composer)

- **Header** (`channel-pane.tsx`, `ui/title-bar.tsx` to 56 px): type icon in feature colour, name, chips (Read only, the restricted roles), topic. Right: the threads and pins buttons (N12, N13), bell (N9), members toggle. Render only the existing ones.
- **Transcript** (`components/chat/*`):
  - Cozy (B1): avatar 40, name in role colour, meta time, body 15/500. Group hover is a rounded `surface/hover` block. The hover toolbar (`message-toolbar.tsx`) is a raised square card with rounded icon buttons: react (N10), reply (N11), thread (N12), more.
  - Compact (B3): one line per message, time column on the left, author right-aligned in role colour.
  - Mention: amber row tint with a 3 px amber left bar, the `@name` chip.
  - Decrypt failure: coral square notice with the reason and "Verify <name>". Failed send: coral text, the reason, a coral "Retry" button and a quiet "Delete".
  - Channel mention chips (`#lfg`) in accent tint.
  - Day dividers: centered date on the hairline. The NEW divider comes with N7.
  - Attachments: square cards. The audio card gets a play button and a waveform (N24). Until N24, keep the native player inside the new card.
- **Channel start** (`ChannelIntro` in `transcript.tsx`): square icon tile, "Welcome to #name", topic, quiet buttons "Pin to tabs" (N1), "Invite people", "Edit channel" (by permission). Variants:
  - Empty channel (B6): add a drop card with the topic's rule and an "Upload" primary button. It uses the existing drop zone and upload tray.
  - Read-only (B7): the composer is a quiet square notice "You can't post in #name. Only <roles> can." with "Follow" (N9).
  - Restricted (B9): a card "Restricted channel" with the role chips and "Manage access" (opens channel permissions).
- **Composer** (`composer.tsx` and friends): rounded (radius 10) on `surface/raised`. "+" on the left. Right: the `E2EE` chip, image, sticker (not in the app: do not render), emoji. Typing indicator under the composer. The key-change pause (E5) shows a coral line above a disabled composer: "Sending is paused, check <name>'s new key".
- **Mocks:** B1, B2, B3, B5, B6, B7, B9, B10, E2, E5, E6.

### Phase 4: right column

- A segmented control "Members | Pages" heads the column in guild channels.
  - **Members** (`member-list.tsx`): groups by hoisted role when N15 lands. Until then, "ONLINE — n" and "OFFLINE — n" (B10 shows this case). Rows: avatar with presence, name in role colour, the crown for the owner, `YOU`, `BOT` (N22, not shown until then), and an activity line: "Speaking in Lounge" and "In Lounge" from voice states (exists), custom status (N16). The live card at the bottom (decision 4).
  - **Pages:** in a pages channel, the column widens to 540 and shows the page (C1). The current pages split moves into this column, with the column header: page avatars (awareness), outline, copy link, pop out, more. Footer: "Saved · end-to-end encrypted" and the word count. In other channels, the Pages tab comes with N21.
- **DM profile column** (E2, E3), new layout from existing data: banner (from the avatar colour, see the feature plan N25), avatar, name, the role in a shared guild, the activity card with "Join" (voice states), the security key card (trust state, fingerprint, "Verify <name>": opens `verification-dialog.tsx`), devices (`listContactDevices`), mutual guilds. The header shows a trust chip: gold "Not verified", green "Verified", coral "Key changed". The DM header call buttons come with N20.
- **Mocks:** B1, B8, B10, C1, E2, E3.

### Phase 5: voice

- **Stage** (`voice-room.tsx`, D1): square tiles on `surface/panel` with the avatar in the centre, name tag top-left, coral mute and deafen badges top-right, a green ring for the speaker. One floating control bar at the bottom: mic, deafen, camera (N19), share, settings, and a coral "Leave". The header shows "Voice · n in call · <region>" and a green "Verify call" chip (opens the dialog).
- **Stream grid** (`stream-grid.tsx`): the same square tiles. Keep focus and full screen.
- **Not joined** (D2): what is happening in the channel (the live card per decision 4, or the participants), "Join voice" (green, primary) and "Watch stream" (N18). A note when the join moves your call: "You're in Lounge. Joining moves your call here."
- **Verify call** (D3, `verify-call-dialog.tsx`): call code in a sunken square box in mono, the gold caution callout, "IN THE ENCRYPTED CALL" list in green ("Has the call keys"), "JOINING" in gold ("Waiting for the call keys…"), "Safety number" per person.
- Use `webrtc-reviewer` if the phase touches `voice.ts`, `voice-e2ee.ts` or a media file. A pure restyle does not.
- **Mocks:** D1, D2, D3.

### Phase 6: dialogs

Restyle each dialog to the dialog spec (Phase 0). Only the layout changes, except where noted.

| Mock | Dialog | File | Notes |
|---|---|---|---|
| F1 | Add a guild | `add-server-dialog.tsx` | two option cards with chevrons (create: accent, join: green), footer "Every guild is end-to-end encrypted" |
| F2 | Join with invite | `join-server-modal.tsx` | invite card: banner, icon, name, online and member counts, code in mono, "Expires in n days" |
| F3 | Invite people | `invite-dialog.tsx` | two limit selects side by side, the link field and "Create link" as one control, a plain-words helper line, keep "include history" (decision 2) |
| F4 | Leave guild | `remove-server-dialog.tsx` | red icon tile, guild card with counts and "member since", red button |
| F5 | Create channel | `create-channel-dialog.tsx` | radio cards in feature colours (text, voice, pages), `#` prefix in the name field, "Private channel" toggle row |
| F6 | Delete channel | `shell/dialogs.tsx` | "You can't undo this." in coral |
| E4 | Verify contact | `security/verification-dialog.tsx` | 60 digits in a sunken 4 × 3 mono grid, "Scan their code", primary "The numbers match — mark as verified", their devices with fingerprints (decision 5) |
| E5, E6 | Key changed | `security/key-change-dialog.tsx` | blocking: coral, verified key against new key. Notice: gold. "Compare safety numbers" is primary |
| I1–I5 | Set-up | `security/onboarding.tsx`, `security-setup-dialog.tsx` | per-step dialogs (decision 3) |
| I6 | New recovery key | `security/recovery-panel.tsx` | gold caution |
| I7 | Link a new device | `security/link-new-device.tsx` | gold warning first, "Scan the code" and "Compare emoji" as a segmented control, paste field as fallback |
| I8 | Link this device | `security/device-link-dialog.tsx` | two option cards (QR, emoji) |
| I9 | Devices | `security/devices-panel.tsx` | gold browser-trust callout, rows with rename and red "Sign out", "Link a new device" primary |

### Phase 7: settings in the sidebar

- New sidebar mode `settings` in `navStore`: `{ kind: 'user' } | { kind: 'guild', guildId } | { kind: 'channel', channelId }` plus the section. The sidebar middle shows: "Back to #<channel>" with `Esc`, the header (icon, name, subtitle), the section list, and the red action set apart (Delete channel, Delete guild, Sign out). The content card shows a breadcrumb header ("Night Owls › Roles") with `Esc ✕`, and the page.
- `Esc` and the back row return to the channel. Search, favourites, the voice dock and the space bar stay.
- Move the section components out of the overlay frame. `settings-layout.tsx` and `side-list.tsx` go away. The section components stay and get the page layout (title 26/800, one-line description, content width about 720).
- Pages:
  - **F7** channel overview: name with `#`, topic with a counter and a live header preview, "You have unsaved changes" with Reset and Save.
  - **F8** channel permissions: role list (with "Add role or member"), three-way switch per permission (deny coral, default, allow green), "Allowed here" and "Denied here" chips, the override count in the nav badge.
  - **G1** guild overview: icon and banner previews, name, voice region, "Earlier messages in public channels" (exists: `publicHistoryVisibility`).
  - **G2** roles: drag list with colour dots and counts, name, colour swatches, "Show as its own group" (N15), permission switches. With Administrator on, the others show dimmed with "VIA ADMINISTRATOR".
  - **G3** members: table with role chips (remove ✕, add +), Kick only where allowed, red on hover.
  - **G4** invites: the create bar (two selects, "Create and copy link", plus decision 2), table with mono codes, creator avatar, uses, expiry (gold when close, grey when used up), copy and delete.
  - **H1** my account: profile card (banner, avatar, name, roles), username, email, user ID (copy), avatar change and remove. Email and username link to Takusen where Takusen owns them.
  - **H2** devices, **H3** recovery key, **H4** security log (timeline): restyle of the existing panels.
  - **H5** appearance: theme cards (dark, light, system), sidebar cards (docked, undocked: N3), message display cards (cozy, compact).
  - **H6** voice and audio: devices side by side, the mic check meter with the quarter mark, sounds in two columns with switch and play. Keep the Updates section on desktop.
- **Mocks:** F7, F8, G1–G4, H1–H6.

### Phase 8: sign-in

- **A1** (`sign-in-screen.tsx`): wallpaper with the violet glow, app mark top-left, one square card: mark, "Sign in to Hachiman", one line, primary "Sign in with Takusen", the helper line, then the E2EE note with the three set-up paths (Link it, Restore it, Start new) as quiet chips that only inform. Footer links: Help, Privacy, Status.

### Phase 9: finish

- Light theme pass on every screen (B2 is the reference).
- Compact display pass (B3).
- Narrow windows: below 1100 px the sidebar starts hidden (N3). Below that, the right column closes by default (as now at 1200).
- Keyboard: focus order through sidebar, tabs, header, transcript, composer. `Esc` rules (close popover, then hide the revealed sidebar, then leave settings).
- Update `apps/hachiman/README.md` diagrams (shell layout, stores) and the top-level `README.md` UI diagram.
- Run the `remove-dumb-comments` and `thermo-nuclear-code-quality-review` skills on the full diff.

## 6. Order and the feature plan

```
Phase 0 ─ Phase 1 ─ Phase 2 ─ Phase 3 ─ Phase 4 ─ Phase 5 ─ Phase 6 ─ Phase 7 ─ Phase 8 ─ Phase 9
             │         │         │         │         │                   │
             N2,N3     N4,N6     N7,N9     N15,N16   N17,N18             N3 (appearance)
             N1,N5               N10,N11   N21,N25
                                 N13,N24
```

- Phases 0–4 are the critical path. Phases 5–8 can run in parallel after Phase 1, because they touch separate files.
- Tier 1 features (feature plan §2) land between Phase 1 and Phase 4, because the mocks depend on them to read correctly: N1 tabs, N2 history, N3 sidebar states, N4 space bar tint, N5 quick switcher, N6 favourites, N7 read state, N11 replies, N15 role groups.
- Tier 2 and Tier 3 features land after the redesign phase that holds their slot.

## 7. Screen coverage

| Mock | Phase | Features needed for the full mock |
|---|---|---|
| A1 Signed out | 8 | — |
| B1 #general dark | 1–4 | N1, N3, N5, N6, N7, N8, N9, N10, N11, N12, N13, N14, N15, N16, N24 |
| B2 #general light | 9 | as B1 |
| B3 #general compact | 3 | as B1 |
| B4 Guild menu | 2 | — |
| B5 #lfg | 3 | N1 (Pin to tabs) |
| B6 #clips empty | 3 | N1 |
| B7 #patch-notes read only | 3 | N9 (Follow) |
| B8 Lattice Labs #standup | 2 | N4 |
| B9 #deploys restricted | 3 | — |
| B10 Dog-ear Club | 2–4 | N14, N16 |
| C1 #design-pages | 4 | N21 (labels, activity post) |
| D1 Lounge in call | 5 | N17, N19 (camera) |
| D2 Ranked queue not joined | 5 | N18 |
| D3 Verify call | 5 | — |
| E1 DM home | 2 | N18 (Watch), N20 (call), N23 (Blocked) |
| E2 DM marlowe | 4 | N20, N25 |
| E3 DM yuki.h | 4 | N25, N26 |
| E4 Verify contact | 6 | — |
| E5, E6 Key changed | 6 | — |
| F1–F6 Guild and channel dialogs | 6 | — |
| F7, F8 Channel settings | 7 | — |
| G1, G3, G4 Guild settings | 7 | — |
| G2 Roles | 7 | N15 |
| H1–H4, H6 User settings | 7 | — |
| H5 Appearance | 7 | N3 |
| I1–I9 Security | 6 | — |
| Sidebar behaviour board | — | N3 |

## 8. Out of scope

- Mobile layouts. The mocks are desktop only.
- The Takusen web app frame (`uKgMD`) and the older "Hachiman chat app" frame (`GQ2rn`) in the same file.
- Any wire change. The redesign phases change only the shared UI and the Electron main window options. Every wire change is in the feature plan.
