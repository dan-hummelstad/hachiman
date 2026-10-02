# Hachiman UI Redesign: Spec

Brief (from the user): a complete redesign of the desktop + web app. Keep the **square** structure (zero radius). Lay pages out like Discord, which already works, and borrow from Slack and buzz.xyz. The **UI font** and the **chat font** are different. The UI uses a Roboto-like sans (but not Roboto), and chat stays monospace. It should feel like an **old messenger** (AIM / ICQ / IRC era), made modern.

## 1. Identity

- **Signature (the one bold thing):** the chat is a *transcript*. It uses Geist Mono, with the name of each author in the role color of that author and quiet timestamps. It reads like an IRC/AIM log inside a modern Discord frame. All other parts stay quiet and disciplined.
- **Old-messenger cues, used sparingly:**
  - Every pane opens with a 48px **title bar** (1px bottom rule, pane title left, pane tools right). This is like the buddy-list and IM windows of the era.
  - Floating surfaces (popovers, menus, dialogs) get a **hard offset shadow** (`4px 4px 0` in `--shadow-ink`) instead of a soft blur. No other surface has a shadow.
  - The signed-out screen is a small **sign-in window** (title bar, compact form), centered on the app background.
- **Square everything:** `--radius: 0`. Avatars are square too, and presence dots are 8px squares. Status uses shape plus color (see §2), never color alone.
- **No** all-caps labels, no `·`-joined meta strings, no `→` on buttons, no gradients, no emoji decoration. Sentence case everywhere.

## 2. Tokens (`apps/hachiman/src/assets/main.css`)

Cool slate surfaces with one warm **signal amber** accent. The accent is the AIM running-man yellow, and nothing like Discord blurple or Slack aubergine. Dark is the default.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--rail` | `#16181d` | `#dfe2e7` | guild rail |
| `--sidebar` | `#1c1f25` | `#e9ecf0` | channel sidebar, member list, settings nav |
| `--background` | `#22252c` | `#f6f7f9` | chat / main pane |
| `--card` / `--popover` | `#2a2e36` | `#ffffff` | raised surfaces, inputs, popovers |
| `--accent` (hover/selected row) | `#2f343d` | `#dde1e7` | list hover/selection |
| `--border` | `#353a44` | `#cfd4db` | 1px rules |
| `--foreground` | `#e6e8ec` | `#1a1d23` | text |
| `--muted-foreground` | `#99a0ac` | `#5b6270` | secondary text, timestamps |
| `--primary` | `#f0b429` | `#c98a0b` | signal amber: primary buttons, unread/selected notch, mention highlight edge, focus ring |
| `--primary-foreground` | `#1b1404` | `#1b1404` | text on amber |
| `--destructive` | `#f2545b` | `#c9303a` | |
| `--online` | `#3fb950` | `#1f883d` | presence: filled square |
| `--idle` | `#d29922` | `#9a6700` | presence: square with a notch (half fill) |
| `--dnd` | `#f2545b` | `#c9303a` | presence: square with a horizontal bar |
| `--offline` | `#6e7681` | `#8c939e` | presence: hollow square (2px border) |
| `--shadow-ink` | `#000000b3` | `#1a1d2333` | hard offset shadow color |
| `--mention` | `#f0b42914` | `#c98a0b14` | mention row background |

Spacing uses the default Tailwind scale, with `--spacing` back to `0.25rem`. Borders are 1px, and focus is a `2px` amber outline offset by `1px` (keyboard only, `:focus-visible`).

## 3. Type

| Role | Face | Size / line-height | Weight |
|---|---|---|---|
| UI (`font-sans`) | **IBM Plex Sans**: a Roboto-like grotesque with a bit of 70s-computing character | 14px / 20px base | 400 / 500 / 600 |
| Pane titles | IBM Plex Sans | 15px / 20px | 600 |
| Page titles (settings, empty states) | IBM Plex Sans | 20px / 28px | 600 |
| Section labels (sidebar groups, settings groups) | IBM Plex Sans | 12px / 16px, `tracking-[0.01em]` | 600, muted, sentence case |
| Meta (timestamps, counts) | IBM Plex Sans, tabular-nums | 12px / 16px | 400, muted |
| Chat body + composer (`font-mono`) | **Geist Mono** | 13.5px / 22px | 400 |
| Chat author names | Geist Mono | 13.5px | 600, role color |
| Code, invite codes, ids | Geist Mono | 13px | 400 |

The repo vendors the fonts as woff2 in `apps/hachiman/src/assets/fonts/` (OFL), with no network loading. The Electron CSP forbids remote fonts. Chat lines stay under about 90ch: the transcript column caps message width at `max-w-[90ch]`.

## 4. Layout

```
┌────┬───────────────────┬──────────────────────────────────────────┬──────────────┐
│ ▣  │ Guild name     ▾  │ # general   topic text…        ⌕  👥  ⚙ │ Members      │  48px title bars
│────│───────────────────│──────────────────────────────────────────│──────────────│
│ ▢  │ Text              │ alice        10:42                        │ Online — 3   │
│ ▢  │  # general      ● │ hey, anyone up for a game?                │ ■ alice      │
│ ▢  │  # random         │ ok in 5                                   │ ■ bob        │
│    │ Voice             │ bob          10:43                        │ Offline — 2  │
│ +  │  ◫ Lounge         │ sure                                      │ □ carol      │
│    │    ■ alice  (spk) │                                           │              │
│    │───────────────────│                                           │              │
│    │ Voice connected   │──────────────────────────────────────────│              │
│    │ Lounge / Guild ⏻  │ [ Message #general                    ]  │              │
│    │ ■ me   🎙 🎧 ⚙    │ alice is typing…                          │              │
└────┴───────────────────┴──────────────────────────────────────────┴──────────────┘
 72px      240px                    flex                                  240px
```

- **Rail (72px):** a home tile (DM home) at the top, then a 1px rule, then the guild tiles. Guild tiles are 40px squares that show the guild icon, or initials in Plex Sans 600 when the guild has no icon. The selected guild gets a 4px amber notch on its left edge. An unread guild gets a 4px muted notch. "+" (create/join) comes last.
- **Channel sidebar (240px):**
  - Title bar shows the guild name and a menu: settings, invite people, create channel, leave.
  - If the guild has a banner, the banner replaces the title bar. The banner is a 240×135 strip (`object-fit: cover`). The guild name and the menu are on the banner, in white text with a text shadow. If the banner does not load, the plain title bar shows.
  - Channel groups have sentence-case collapsible headers (they are categories).
  - Rows are 32px. Text channels show a `#` glyph and voice channels a speaker glyph. Voice occupants sit indented under their channel. The avatar of a speaking occupant gets a 2px `--online` outline. An occupant who shares a screen gets a red "LIVE" mark.
  - Bottom stack: a **voice connected panel** (only while in voice: channel / guild, quality, share screen, stream quality, disconnect). Below it is the **user panel** (avatar + presence, name, mic / deafen / settings buttons).
- **Main pane:**
  - Title bar: channel glyph + name, a 1px vertical rule, then topic (truncated). Tools on the right: member list toggle, pinned/search later (do not add placeholders), and channel settings when permitted.
  - Body: the transcript.
  - Footer: the composer plus a typing line.
- **Voice room** (the main pane of a voice channel):
  - Live screen shares show at the top, in a grid of black tiles. Each tile shows the video, the sharer's name with a "LIVE" mark, and a full-screen button.
  - Click a tile to show only that stream. Click it again to show all streams.
  - Only users in the same voice session see the video.
  - Occupant tiles and the controls come below the shares. The controls are mute, deafen, share screen, stream quality and leave.
  - On the desktop app, share screen opens a source picker window. It shows screens, then windows, as thumbnails with names, and the two stream quality selects. A click on a thumbnail starts the share. The browser shows its own picker.
  - Stream quality is a popover with two selects. Resolution has 720p, 1080p, 1440p and Source. Frame rate has 15, 30 and 60 fps. The default is 1080p at 30 fps. A change applies to a live share immediately.
- **Member list (240px):** grouped "Online — n" / "Offline — n". Rows show avatar + presence square + name in role color. A click on a row opens the profile card.
- **DM home:** the sidebar becomes "Direct messages" (DM rows with presence). With no DM open, the main pane shows **People**. People lists everyone you share a guild with, grouped by online/offline, each with a "Message" button (a Slack-like directory).
- **Settings (guild / channel / user):** full-window overlays, as in Discord. A left nav column (`--sidebar`) holds the section list, with a destructive action at the bottom. Content sits on the right with a max width of 720px. Esc or a square ✕ button at the top right closes it.
- **Modals** (create/join guild, create channel, invite, confirm): a narrow window with a title bar, a body, and right-aligned actions. Modals use the hard offset shadow.
- **Electron:** frameless-ish. On macOS, use `titleBarStyle: 'hiddenInset'`. Give the app a 28px draggable top strip (`-webkit-app-region: drag`) with the window title centered in 12px muted Plex Sans. The browser host shows no strip.

## 5. Transcript (the signature)

- **Cozy (default):** a group header line shows a 32px square avatar in the gutter, then the author, then the time. The author is Geist Mono 600 in role color. The time is 12px Plex Sans, muted. Bodies are Geist Mono 13.5/22. Messages from the same author within 7 minutes merge into the group. When you hover on a continuation line, its time shows in the gutter.
- **Compact (setting):** IRC-style single lines, `10:42  alice  hey, anyone up?`. The fixed-width time column and right-aligned author column make this the most "old messenger" view.
- A day divider is a 1px rule with the date centered in 12px muted Plex Sans.
- A row shows `--accent` on hover. The message toolbar is a small square floating cluster at the top right of the row (Slack-style). It has a hard shadow.
- Mentions of me get the `--mention` background and a 2px amber left edge.
- Pending (optimistic) messages render at 50% opacity. A failed message shows in destructive text with a "Retry / Delete" link pair.
- Attachments show below the message text. A message can have attachments and no text.
  - One image shows inline in a box of 400×300 or smaller. The box gets its size from the image width and height before the image loads, so the transcript does not move. Two or more images show as a grid of square cells. A click on an image opens the lightbox (filename title bar, image, size, "Open original").
  - A video shows in a player with the same limits. An audio file shows as a card with the filename, the size and a player. All other files show as a card with a file glyph, the filename (a download link) and the size.
- Composer: an attach button, file drop on the channel body, and paste. Files upload immediately and show in a tray above the input: square tiles with a thumbnail or a file glyph, a progress bar, and a remove button. Send waits until all uploads are complete.
- Avatars show the uploaded image. If a user has no avatar, or the image does not load, the avatar shows the initial.
- Empty channel: one quiet block, "This is the start of #general." plus the topic.

## 6. Components and ownership

The `components/ui/*` primitives (shadcn) keep their APIs and change only their styling.

| Area | Files |
|---|---|
| Foundation + primitives + host chrome | `assets/main.css`, `assets/fonts/*`, `components/ui/**`, `components/theme-*`, both host apps' HTML/window chrome |
| Shell + left column | `App.tsx`, `server-icon-rail.tsx`, `channel-sidebar.tsx`, `nav-user.tsx` (user panel), `voice-controls.tsx` (voice connected panel), `create-channel-dialog.tsx`, new `components/shell/*` |
| Main pane + right column | `chat-area.tsx` (may split into `components/chat/*`), `message-toolbar.tsx`, `member-list.tsx`, `user-profile-popover.tsx`, new `home-pane.tsx` (People) |
| Overlays + auth | `guild-settings-*.tsx`, `channel-settings-dialog.tsx`, new `user-settings.tsx`, `add-server-dialog.tsx`, `join-server-modal.tsx`, `remove-server-dialog.tsx`, `oracle-signin-*.tsx`, `settings-helpers.ts`, new `components/settings/*` |
| Preview fixtures + visual QA | new `apps/hachiman/src/dev/*`, and the preview hook in `apps/hachiman-browser/src/main.tsx` |

Cross-area contracts:
- `App.tsx` mounts `<UserSettings open onClose />` from the overlays area. The gear in the user panel calls `onOpenUserSettings`.
- The user settings Appearance tab writes `theme: 'dark' | 'light' | 'system'` and `messageDisplay: 'cozy' | 'compact'`. Both live in a new tiny persisted `usePrefsStore` (`stores/prefsStore.ts`, owned by the overlays area). `ThemeProvider` applies `theme` to `<html>`, and the transcript reads `messageDisplay`.
- User settings Voice: input/output device pickers write `inputDeviceId` / `outputDeviceId` to `usePrefsStore`. `VoiceService` should honor them where it is cheap: `getUserMedia({audio:{deviceId}})` and `HTMLMediaElement.setSinkId`.
- Sounds: `services/SoundService.ts` plays one sound for each Discord sound event. `lib/sounds.ts` lists them.
  - Voice sounds are soft bell chimes (`lib/chime.ts`), as in Discord. An "on" sound rises, and its "off" sound plays the same notes falling.
  - Message sounds are Cuelume cues. A received message plays a glass note, and a sent message plays a soft whoosh.
  - Received messages: a DM or a mention of me. No sound when I look at that channel. Each message that I send plays the sent sound.
  - My voice actions: join, leave, connection lost, mute, unmute, deafen, undeafen, share start, share stop.
  - Other users in my voice channel: join, leave, share start, share stop.
  - Settings: User settings → Voice and audio has a "Play sounds" switch and a volume slider. Each sound also has a switch and a play button. `prefsStore` keeps these choices in local storage.

## 7. Preview mode (for visual QA without a backend)

In the browser dev server only (`import.meta.env.DEV`), `?preview` seeds the mirror stores with a realistic fixture:
- 3 guilds, categories, text and voice channels.
- About 12 members with roles/colors/presences.
- Voice occupants, with one speaking.
- About 40 messages, including a mention, a pending one and a failed one.
- 2 DMs.
- A fake signed-in Oracle session.
- A stub for `hachiman.rest.*`, so clicks do not throw.

It never ships in production builds. Use it with the `run` skill or Playwright to take a screenshot: `http://localhost:5173/?preview`.
