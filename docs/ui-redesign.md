# Hachiman UI: the Arc spec

This document is the UI spec of the shared UI (`apps/hachiman`). The source of the design is the Pencil file `pencil-new.pen`, frame **Final** (`X9RV1V`). The work plan is `docs/arc-redesign-plan.md`. The features that the design needs and the app does not have yet are in `docs/arc-new-features-plan.md`.

## 1. Identity

Header of the Final frame: "Arc sidebar. Square structure. Rounded interaction."

- **Square is structure.** Windows, panels, columns, cards, dialogs, popovers, menus, tables, banners, notices, embeds, attachments and system tags have radius 0.
- **Rounded is interaction.** Buttons, inputs, search, the composer, tabs, toggles, checks, radios, chips, reactions, selected and hovered rows, badges and avatars are rounded.
- **Colour marks the feature.** Accent violet marks selection and actions. Green marks voice. Amber marks events. Violet marks pages. Sky marks threads. Coral marks live and errors. Teal marks bots.
- **One sidebar.** One sidebar (280 px) holds all items that are not content. A space bar at its foot replaces the guild rail.
- **One content card.** The content sits on one card, inset 8 px from the right and bottom edges of the window, with a 1 px border. The window behind it is a wallpaper.
- **Soft shadows only on floating surfaces.** Popovers, menus, dialogs and the revealed sidebar get `shadow-soft`. No other surface gets a shadow.
- **Settings use the sidebar.** Settings replace the middle of the sidebar with their section list and show the page in the content card (§7). Dialogs are only for actions: create, invite, leave, delete, verify, link.

### No placeholders

Ship an element only when its feature exists. When an element needs a feature that is not built, do not render it. The region keeps its size and stays empty, or the control is absent. The feature PR adds the element. Examples: the tab bar, unread badges, the inbox button, reactions, the thread and pin buttons, the event row, the camera button.

## 2. Tokens (`apps/hachiman/src/assets/main.css`)

Each token is a CSS variable with a dark and a light value. Dark is the default. `@theme inline` exposes each token to Tailwind as a colour: `--surface-content` becomes `bg-surface-content`, `border-surface-content` and `text-surface-content`.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--surface-window` | `#0E0F15` | `#F7F7FB` | the window wallpaper |
| `--surface-content` | `#1D1E28` | `#FFFFFF` | the content card, dialogs, menus |
| `--surface-panel` | `#17181F` | `#F8F8FB` | the sidebar, cards on content |
| `--surface-raised` | `#262836` | `#F1F1F6` | secondary buttons, chips, callouts |
| `--surface-sunken` | `#0F1016` | `#FFFFFF` | inputs, the segmented control track |
| `--surface-hover` | `#FFFFFF0F` | `#23204A0D` | hovered rows and quiet buttons |
| `--surface-selected` | `#7B6CFF2B` | `#6B5BF52B` | the selected row |
| `--surface-scrim` | `#05060AB8` | `#16151F66` | the dialog scrim |
| `--line-hairline` | `#2A2C3B` | `#E3E3EC` | 1 px rules and borders |
| `--line-strong` | `#363849` | `#DCDCE6` | input borders |
| `--line-focus` | `#7B6CFFB3` | `#6B5BF599` | the focus ring |
| `--text-primary` | `#F3F4FA` | `#16151F` | body text |
| `--text-secondary` | `#B6B9CE` | `#4E5066` | secondary text |
| `--text-tertiary` | `#80839A` | `#6E7088` | meta, timestamps, section labels |
| `--text-disabled` | `#5C5F76` | `#9C9EB2` | disabled text |
| `--text-on-accent` | `#FFFFFF` | `#FFFFFF` | text on accent, danger and live fills |
| `--accent-primary` / `-text` / `-tint` | `#7B6CFF` / `#C9C2FF` / `#7B6CFF2B` | `#6B5BF5` / `#5B4AE8` / `#6B5BF52B` | actions and selection |
| `--feature-voice` / `-text` | `#3DD68C` / `#3DD68C` | `#34C77F` / `#12945A` | voice |
| `--feature-event` / `-text` | `#FFB547` / `#FFB547` | `#F5A524` / `#B7700A` | events, caution, mentions |
| `--feature-page` / `-text` | `#B98CFF` / `#B98CFF` | `#A87BF2` / `#8A55E0` | pages |
| `--feature-thread` / `-text` | `#4CC2FF` / `#4CC2FF` | `#3DB5F5` / `#1584BE` | threads |
| `--feature-danger` / `-text` | `#FF5D6E` / `#FF5D6E` | `#F04A5C` / `#D93649` | live, errors, destructive actions |
| `--feature-activity` | `#FF6FAE` | `#E0569A` | activity |
| `--feature-bot` | `#2DD4BF` | `#2DD4BF` | bots |
| `--status-online` / `idle` / `dnd` / `live` / `offline` | green / amber / coral / violet / `#5C5F76` | green / amber / coral / violet / `#9C9EB2` | presence |
| `--tint-home` | `#1C2130` | `#E7EAF1` | the wallpaper of the DM space |

Use the `-text` variant of a feature colour for text and icons. Use the base colour for fills and bars. Guild tints and role colours in the mocks are example data, not tokens.

The shadcn names (`--background`, `--card`, `--popover`, `--primary`, `--accent`, `--border`, `--input`, `--ring`, `--muted-foreground`, `--destructive`, `--sidebar`, `--rail`, `--online` and the others) map onto these tokens. Old code keeps working. New code uses the Arc names. Note that shadcn `bg-accent` is the hover wash, and Arc `bg-accent-primary` is the violet.

**Radii:** `rounded-structure` 0, `rounded-check` 4 px, `rounded-control` 8 px, `rounded-option` 10 px, `rounded-pill` 999 px. `rounded-sm` to `rounded-xl` stay 0.

**Space:** 4, 8, 12, 16, 20, 24, 32, 40 px. Use the default Tailwind scale (`--spacing: 0.25rem`).

**Focus:** keyboard focus (`:focus-visible`) shows a 2 px `--line-focus` outline, offset 1 px. Text fields show an accent border instead.

## 3. Type

**Figtree** is the face of all UI and chat text. **IBM Plex Mono** is the face of keys, safety numbers, codes, invite codes and token names. The repo vendors both as woff2 in `apps/hachiman/src/assets/fonts/` (SIL OFL). The CSP allows no font host.

| Role | Class | Size / weight / extra |
|---|---|---|
| Display | `text-display` | 48 / 800 / tracking −1 px |
| Page title | `text-page-title` | 26 / 800 |
| Section title | `text-section-title` | 22 / 800 |
| Heading | `text-heading` | 16 / 800 |
| Body (chat) | `text-body` | 15 / 500 / line height 1.45 |
| UI label | `text-label` | 14 / 600 |
| Meta | `text-meta` | 12 / 500 |
| Section label | `section-label` | 11.5 / 800 / tracking +0.7 px / uppercase / tertiary |
| Mono | `font-mono text-mono-key` | 15 / 600 |

The base UI text is 14 / 20, weight 500. The chat is not monospace.

## 4. Icons

Use Lucide (`lucide-react`) with stroke 1.5. Sizes: 16 px in rows and controls, 18 to 20 px in headers and voice controls, 13 to 14 px in chips. An icon takes the colour of its feature. Else it takes the colour of its text. The iconography board of the Final frame gives the icon for each use.

## 5. Primitives (`apps/hachiman/src/components/ui/`)

| Primitive | File | Notes |
|---|---|---|
| Button | `button.tsx` | `variant`: `primary`, `secondary`, `danger`, `danger-outline`, `quiet`, `voice`, `link`. The old names `default`, `destructive`, `outline` and `ghost` are aliases. Radius 8. |
| Input, textarea | `input.tsx`, `textarea.tsx` | Sunken fill, strong border, radius 8, accent border on focus. |
| Native select | `native-select.tsx` | The input look with a chevrons-up-down mark. `className` styles the wrapper. |
| Switch | `switch.tsx` | Pill. Accent track when on. |
| Checkbox | `checkbox.tsx` | A native checkbox, radius 4. |
| Radio card | `radio-card.tsx` | Radius 10. Icon tile and selected border in the colour of `feature`. |
| Keycap | `keycap.tsx` | `⌘K`, `Esc` in IBM Plex Mono. |
| Chip | `chip.tsx` | Pill button. `selected` gives the accent outline and tint. |
| Badge | `badge.tsx` | Pill count. `tone`: `danger`, `accent`, `quiet`. |
| System tag | `system-tag.tsx` | Square uppercase tag. `kind`: `page`, `live`, `bot`, `new`, `you`, `encrypted`, `key-changed`. |
| Segmented control | `segmented-control.tsx` | Two or three views in one control, for example Members and Pages. |
| Callout | `callout.tsx` | Square notice with a left bar. `tone`: `info`, `caution` (gold), `danger` (red), `success` (green). |
| Avatar, presence | `avatar.tsx`, `presence.tsx`, `shell/user-avatar.tsx` | Circle avatar. Circle presence dot on the bottom-right corner. |
| Dialog | `dialog.tsx`, `modal-window.tsx` | See below. |

`feature.ts` holds the class maps for the feature colours (`FEATURE_TEXT`, `FEATURE_TILE`, `FEATURE_BORDER`). Use them when a component takes a `feature` prop.

**Dialog.** A dialog is a square card on `--surface-scrim`, 500 to 640 px wide. The header (padding 16 / 22) has an icon tile in a feature colour, the title (18 / 800) and an optional subtitle (meta, tertiary). The close button is at the top right. The body has padding 18 / 22. The footer (padding 14 / 22) has a hairline rule on top and the actions on the right. A destructive dialog has a red icon tile, one plain sentence about the consequence, and the red button on the right. Pass `icon` and `feature` to `DialogHeader` or `ModalWindow`.

## 6. Layout metrics (window 1440 × 900)

| Region | Size |
|---|---|
| Sidebar | 280 wide, padding 10 |
| Pinned tab bar | 48 high, tabs 34, gap 4 |
| Content card | inset 8 right and bottom, 1 px border |
| Chat header | 56 high, padding 0 / 12 / 0 / 20 |
| Composer | 52 high, area padding 0 / 16 / 12 / 16 |
| Members column | 252 wide (page column 540) |
| Message | avatar 40, gap 14, padding 6 / 10 |
| Channel and category row | 30 high, padding 0 / 8 / 0 / 10 |
| Voice participant row | 26 high, indent 34 |
| Event row | 38 high |
| DM favourite tile | 46 |
| Voice dock | about 93 high, buttons 32 |
| Space bar | 40 high, guild icons 26 |
| Dialog | 500 to 640 wide |
| Popover | 480 wide |
| Settings page | header 76, content padding 28 |
| Hit target | 32 minimum |

## 7. Shell rules

`components/shell/shell.tsx` builds the shell. `apps/hachiman/README.md` ("Shell layout") has the component map.

### Sidebar

The sidebar has four slots, top to bottom:

| Slot | Contents |
|---|---|
| controls (40 high) | the sidebar toggle, back, forward, and the inbox at the right. On macOS the row starts after the traffic lights. The row is the window drag region |
| top | the quick switcher field ("Search or jump to… ⌘K") and the favourite DMs strip |
| middle | the channel list of the guild, the DM space, or the settings sections (`SettingsNav`). It scrolls |
| foot | the voice dock and the space bar |

The sidebar has three states:

- **Docked.** The sidebar sits beside the content column.
- **Hidden.** The content card takes the window width (inset 8). The sidebar controls move to the start of the tab bar. Search and the inbox move to its end. A faint 8 px strip marks the hot zone at the left edge. The voice dock floats in the bottom-left corner of the content card, and the composer moves right to clear it.
- **Revealed.** A hidden sidebar slides in over the content with a soft shadow. Nothing in the content moves.

| Rule | Value |
|---|---|
| Toggle | ⌘S (Ctrl S) or the sidebar button. `prefsStore.sidebar` keeps the choice (`docked` or `undocked`) |
| Reveal | the pointer in the left 8 px of the window. The sidebar slides in over 150 ms |
| Hide | 300 ms after the pointer leaves. Not while a menu, a drag, a focused text field in the sidebar or the quick switcher holds it |
| Esc | hides a revealed sidebar |
| Dialogs | open above everything. A revealed sidebar closes first |
| Narrow windows | below 1100 px the sidebar starts hidden |

`lib/sidebar-reveal.ts` holds these values.

### Settings in the sidebar

Settings do not cover the window. `SettingsNav` replaces the sidebar middle with the section list and a back row. `SettingsPage` shows the open section in the content card (header 76, content padding 28). A page with changes shows the save bar at its foot. The avatar in the space bar opens the user settings. The guild menu and the channel header open the guild and channel settings.

### Tab bar

- The tab bar is 48 high and runs above the content card. It is the window drag region. Tabs and buttons in it are not.
- It holds the pin glyph, the pinned tabs and "+". The pin glyph pins or unpins the open view. "+" opens the quick switcher in pin mode.
- A tab is 34 high, 52 to 200 wide, radius 8. It shows the guild crest, the type icon in its feature colour, the name and one state mark: a white dot for unread, a coral count for mentions, or green voice bars for my call.
- A tab lights up only when its target is the open view. Opening a view that is not pinned adds no tab. The lit tab shows ✕, which unpins it.
- Drag reorders the tabs. ⌘1 to ⌘9 open tab 1 to 9. When the tabs do not fit, they shrink, then the bar scrolls.
- `tabsStore` keeps the tabs per account on this device. A tab whose target is gone goes away.

### Right column

| Channel | Column |
|---|---|
| Text channel | "Members \| Pages". Members is 252 wide. The Pages tab lists the pages of the guild, and an open page widens the column to 540 |
| Pages channel | Pages is the default tab. The open page is 540 wide |
| DM | the profile of the other user (252) |
| Group DM | no column |

The column opens by default on windows of 1200 px and wider. The header toggle overrides the default.

### Channel header

From left to right after the name and topic: the threads button (sky, with the thread count), the pins button (amber, with the pin count), the bell (notification level), the right column toggle and the settings gear (only for a user who can manage the channel). A button without a count is a plain icon button. A thread header has no settings gear. A channel that cannot hold threads shows no threads button. A voice channel shows no pins and no bell.

### Transcript

- **NEW divider.** A coral hairline with a NEW tag on the right, above the first message after the read point. The read point is the one that the channel had when it opened. The divider stays until another channel opens.
- **Reactions.** Pill chips under the message: emoji and count. My reaction gets the accent ring and tint. A click toggles my reaction. The last chip adds a reaction. A message with no reactions shows no chips: the React button in the hover toolbar adds the first one.
- **Replies.** A reply shows a quote of its target above the text. A click on the quote jumps to the target.
- **Page cards.** A message with a page link shows a square card with the page title, its channel and "Open". Page edits do not show in the chat.
- **Mentions in the composer.** Type `@` for members, roles and @everyone, or `#` for channels and pages. The arrow keys move through the list, Enter or Tab picks, and Esc closes it. A picked role shows as `@Name` and is sent as `<@&roleId>`. A picked page is sent as a page link, so it shows as a page card.
- **Blocked users.** A message of a blocked user shows as one collapsed line, "Blocked message". A click shows it.

## 8. E2EE rules in the UI

- Show a message only after the crypto Worker decrypts it. A message that does not decrypt shows a danger callout with the reason.
- Show an attachment only as an object URL of the decrypted blob.
- Show a stream thumbnail only to members of that call. Outside the call, show the avatar of the streamer on the live tint with "LIVE · n watching".
- Trust is per user. Device rows show the device fingerprint. The badge shows the trust of the user.

## 9. Preview mode

In the browser dev server only, `?preview` fills the stores from `apps/hachiman/src/dev/preview/`. The fixture uses the cast of the mocks: Night Owls, Lattice Labs and Dog-ear Club, and the users marlowe, Juni, ozzy, kestrel (you), yuki.h, quill, renata, petra_v, sable, tobias, wren and vexbot. Compare each screen with its mock. Add `&theme=light` for the light theme. `apps/hachiman/src/dev/README.md` lists the fixture cases.

## 10. Sounds

`services/SoundService.ts` plays one sound for each sound event. `lib/sounds.ts` lists the events. Voice sounds are soft bell chimes (`lib/chime.ts`). Message sounds are Cuelume cues. User settings, Voice and audio, has a "Play sounds" switch, a volume slider, and a switch and a play button for each sound.
