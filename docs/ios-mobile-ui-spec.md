# iOS mobile UI: Phase 5 implementation spec

This spec turns Phase 5 of `docs/ios-app-plan.md` into work packages that agents can build one at a time. It names the files, the order, the checks and the features that stay hidden.

Path rule: a path that starts with `apps/`, `pkgs/` or `docs/` is relative to the repo root. Any other path is relative to `apps/hachiman/src/`. "(new)" marks a file that does not exist yet. "(new, X)" marks a file that package X creates and a later package takes over.

## 1. Purpose and source

The source is the pen.dev document, frame **Final - Mobile** (`GZi9q`). It has six rules, the behaviour specs (`X9zRx`), the mobile kit (`01 · Mobile kit`) and 67 phone screens, M1 to M67, in rows A to J. Each phone is 393 × 852. M11 and M12 are light. All other phones are dark.

The six rules:

1. Chat is the screen.
2. The same sidebar comes in as a drawer from the left.
3. Members and pages come in as a drawer from the right.
4. Voice stays in reach (the voice bar on the composer).
5. Pages open on their chat.
6. Settings push in from the right. Choices rise as sheets.

The board lead text: "structure stays square, anything you touch stays rounded, nothing you touch is under 36 px and primary buttons are 48 tall."

Most screens port a desktop page that exists. So most of this phase is a new layout for existing shared-UI code, not new features. All work sits behind one layout switch. Desktop and the wide browser do not change.

### 1.1 Corrections to Phase 5 of the plan

- **M62 Follow exists.** `FollowButton` is in `components/notify/notify-menu.tsx`, and `components/chat/chat-body.tsx` uses it. Only push delivery for a followed channel is new.
- **Voice channels have no text chat.** The "Voice chat" header button in M10, M64 and M65 has nothing behind it.
- **There is no camera in calls.** N19 is not built.
- **There are no bot accounts and no rich embeds.** M1, M11, M62 and M63 show them as sample content.
- **Search has no message search.** The inbox has no replies, no invites, no history and no bulk "mark all read".
- **The composer Record button is a new feature** (voice messages). Nothing in the repo records audio.
- **M5 shows three actions that do not exist.** "Copy text" is client-only and in scope. "Mark unread" needs a server change. "Report message" has a server route but no UI wiring.
- **Native hooks.** Plan 5.5 names four hooks: `haptic`, `share`, `scanQr` and `setAppearance`. All four are in the seam (`shared/IPlatformService.ts`) and the iOS bridge. This spec adds one more, `saveTextFile` (P5), for "Save to Files" in rows C and D. The seam takes `setAppearance({ theme, background })` with a hex colour, not the plan's `{ theme, tint }`. `share` needs an http(s) `url`. Text can go only beside a URL.

Section 5 lists all features that the mocks show and the code does not have.

## 2. Foundation

### 2.1 Tokens

`assets/main.css` already has the board's tokens in both modes: all `surface/*`, `line/*`, `text/*` and `accent/*` values, the `feature/*` values except `activity`, the `status/*` values except `live`, `tint/home`, the radii (`--radius` 0, check 4, control 8, option 10, pill 999), the fonts and the 4 px spacing scale. No work is needed for these.

**New tokens** (P1 adds them under `:root` and `.dark`):

| Token | Dark | Light | Used by |
|---|---|---|---|
| `--surface-scrim-drawer` | `#05060AA6` (65 %) | `#16151F59` (35 %) | drawer scrim (M2, M4, M12) |
| `--surface-scrim-lift` | `#05060AC7` (78 %) | `#16151F73` (proposed) | long-press lift (M5) |
| `--shadow-drawer` | `12px 0 48px #000000B3` | `12px 0 48px #1C1A3A2E` | both drawers (mirrored on the right) |
| `--shadow-sheet` | `0 -8px 32px #00000080` | `0 -8px 32px #16151F1F` (proposed) | bottom sheets |
| `--line-sheet` | `#FFFFFF1F` | `#23204A24` | drawer and sheet edge |
| `--fill-control` | `#FFFFFF12` | `#23204A0F` (proposed) | 36 px chips, secondary button, record |
| `--fill-control-strong` | `#FFFFFF1F` | `#23204A1A` (proposed) | attach button, divider |
| `--sheet-handle` | `#FFFFFF33` | `#16151F33` (proposed) | sheet handle |
| `--feature-activity` | `#FF6FAE` | `#E0569A` | Notifications tile (M29) |
| `--status-live` | `var(--feature-page)` | `var(--feature-page)` | the purple streaming dot (M56) |
| `--safe-top`, `--safe-bottom` | `env(safe-area-inset-top)`, `env(safe-area-inset-bottom)` | same | every mobile frame |

The sheet scrim stays the existing `--surface-scrim` (72 % dark, 40 % light). Do not change it, because desktop dialogs use it. So the app has three scrim levels: drawer (65 %), sheet (72 %) and lift (78 %). The behaviour spec text says sheets rise "over a 65 % scrim". The drawn sheets use `#05060AB8` (72 %). This spec follows the drawings.

**Kit literals: map them, do not add them.**

| Kit literal | Use |
|---|---|
| Field box `#14151C`, stroke `#2E3042` | `surface-sunken`, `line-strong` |
| Header line `#272937`, panel top `#2E3042` | `line-hairline` |
| Action sheet `#1A1B24` | `surface-panel` |
| Voice bar `#132019` + `#3DD68C47` | `bg-feature-voice/10` on `surface-window`, `border-feature-voice/28` (as the desktop VoiceDock) |
| Back and toggle buttons `#FFFFFF0F` | `surface-hover` |
| Lift stroke | `accent-primary/40` |
| Kick text `#FF8A96`, chip text `#DCDEEA` | `feature-danger-text`, `text-primary` |

**Do not add:** `tint/night-owls` and the other sample guild tints (code computes them in `lib/guild-tint.ts`), `role/*` (role data), and the `takusen/*` sets (Takusen branding, only inside the system sign-in sheet).

`surface/shadow` on the board is one colour. The CSS `--shadow-soft` is a full shadow. Keep `--shadow-soft`.

### 2.2 The layout switch

- `hooks/use-layout.ts` (new) exports `useLayout(): 'desktop' | 'mobile'` and `layoutNow()` for code outside React.
- Mobile is true when `platform.platform === 'ios'`, or when `(max-width: 767px)` matches, or when `(pointer: coarse) and (max-height: 500px)` matches (a phone in landscape in the browser host).
- `App.tsx` writes the result to `document.documentElement.dataset.layout`. It must be on `<html>`, so Radix portals in `<body>` see it.
- `assets/main.css` adds `@custom-variant mobile (&:where([data-layout=mobile], [data-layout=mobile] *));`. Leaf sizes use `mobile:` classes, not JS.
- `hooks/use-mobile.ts` stays as it is. `hooks/use-layout.ts` builds on `hooks/use-media-query.ts`.
- JS branches on the layout are allowed in: `App.tsx`, the `components/ui` primitives that change form (dialog, menus, popover), and the leaf components that a package names. The desktop shell (`components/shell/shell.tsx`) gets no mobile branch.

Base CSS under `[data-layout=mobile]`: `overscroll-behavior: none`, `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation`, and `font-size: 16px` on `input`, `textarea` and `[contenteditable]`. A field under 16 px makes iOS zoom the page on focus. The kit draws 15.5 px values. Use 16 px.

A browser window that crosses 767 px swaps the two shells. The composer draft in `hooks/use-draft.ts` survives. Open drawers and scroll positions do not. This is accepted.

### 2.3 The MobileShell frame

`App.tsx` renders `<CryptoGate>{mobile ? <MobileShell/> : <Shell/>}</CryptoGate>`. `components/mobile/mobile-shell.tsx` (new) is the only mobile shell.

```
┌ safe top (env, 54 on the mock) ─ tinted window ─────────┐
│ Mobile / Tab Strip 48                                   │
├ chat card: surface-content, top hairline ───────────────┤
│ Channel header 56                                       │
│ [Page bar 60, pages channels only]                      │
│ Transcript (bottom-aligned, scrolls)                    │
│ Typing line 22                                          │
│ Voice bar 52 (while connected, hidden with keyboard)    │
│ Composer 60, or the read-only notice                    │
│ safe bottom (env, 34) on the content colour             │
└─────────────────────────────────────────────────────────┘
  + left drawer (Sidebar 320), right drawer (RightColumn 320)
  + pushed screen layer (settings, page)
  + sheet and dialog layer (Radix portals)
```

- The root is `fixed inset-x-0 top-0 h-(--app-height,100dvh)` with the `WALLPAPER` classes and `useGuildTint` vars, as the desktop shell has.
- It keeps the desktop rule "select the first text channel" (exported from `components/shell/shell.tsx` as `useDefaultChannel`).
- It mounts `QuickSwitcher` and `IncomingCall`. It does not mount `useSidebarReveal` or `useGlobalShortcuts`. It keeps `useAppShortcuts` for a hardware keyboard, with the sidebar keybind mapped to the drawer.
- The `VoiceDock` renders directly in the left drawer foot. The drawer is always mounted and `inert` while closed, so the dock never remounts.
- The chat card stays mounted under drawers, sheets and pushed screens. The open tab and the scroll position stay.

### 2.4 Drawers

- `components/mobile/drawer.tsx` (new): `Drawer({ side, open, progress, onClose, children })`. Width `min(320px, 100vw - 48px)` (320 on the iPhone SE too, §2.12). Full height.
- Closed: `translateX(∓100%)`. While a finger drags: `translateX(progress)`. Transition `transform 250ms cubic-bezier(.32,.72,0,1)`. The reduced-motion rule in `assets/main.css` removes the slide.
- Left drawer: `WALLPAPER` fill, `border-r` in `--line-sheet`, `--shadow-drawer`. It holds `Sidebar` (`components/shell/sidebar.tsx` gets a `className` prop).
- Right drawer: `surface-panel`, `border-l`, mirrored shadow. It holds `RightColumn` with `variant="drawer"`. Mount it at the first open or at the gesture start, not before. A mounted column re-renders on every presence event and runs Worker calls for a DM.
- The scrim is a `button` with an `aria-label` ("Close sidebar", "Close members"). A tap closes the drawer.
- The drawer is `role="dialog"` with `aria-modal`. It takes the focus on open and gives it back to the toggle on close. Escape closes it.
- `components/mobile/drawer-state.ts` (new): a zustand store `{ open: 'left' | 'right' | null }`, never persisted. Do not use `prefsStore.sidebar` or `toggleSidebar`. The browser host shares that pref with wide windows.
- The same file exports `useChatCovered()`: true while a drawer is open or a pushed screen shows. `components/chat/transcript.tsx` uses it to pause mark-read.
- Close rule (pure, `lib/mobile-drawer.ts` (new) with a test): a navigation to a channel, DM, thread or page closes the drawer. A guild switch keeps it open, so the channel list shows. A dialog that opens closes the drawer.

**Gestures** (`components/mobile/use-swipe.ts` (new) over the pure `lib/swipe.ts` (new) with a test, the same pattern as `lib/sidebar-reveal.ts`):

- A touch that starts in the left 24 px plus the left safe inset and moves right opens the left drawer.
- A left swipe that starts anywhere in the chat body opens the right drawer.
- A touch that starts in a horizontal scroller or in `[data-swipe-ignore]` does not start a gesture (tab strip, code blocks, image rows, chip rows, the composer field).
- Axis lock after 10 px when `|dx| > 1.2·|dy|`. Then `setPointerCapture`, and the drawer follows the finger.
- Commit past 35 % of the width or faster than 0.5 px/ms. Else snap back. `lib/swipe.ts` calls `shouldCommitDrag` from `lib/drag-commit.ts` (P2, also the sheet handle), so the rule has one copy.
- A drag toward the drawer's own edge closes it.
- On a pushed screen, the left-edge swipe means Back. The drawer gesture is off there.
- While a sheet or dialog is open, no swipe gesture runs.
- The transcript gets `touch-action: pan-y`, so vertical scroll stays native.
- In mobile Safari (browser host), Safari's own edge-back gesture wins. There the buttons are the path. The WKWebView keeps `allowsBackForwardNavigationGestures = false`.

### 2.5 Sheets and dialogs

One presentation switch in `components/ui/dialog.tsx`: `DialogContent` gets `presentation?: 'sheet' | 'dialog' | 'fullscreen'`. On mobile the default is `'sheet'`. On desktop the prop has no effect.

| Presentation | Used by | Look |
|---|---|---|
| `sheet` | every dialog by default: `ModalWindow` (16 users) and the direct users | bottom-anchored, full width, square, `border-t` `--line-sheet`, `--shadow-sheet`, handle row, 250 ms slide up, swipe down on the handle closes |
| `dialog` | `ConfirmDialog` (M50, M51), `KeyChangeDialog` while blocking (M58) | centred, 16 px inset, header 64, footer with Secondary Cancel and the red or primary action side by side, red last |
| `fullscreen` | `components/chat/attachments/lightbox.tsx`, `components/security/screen-window.tsx` | fills the viewport inside the safe areas |

The confirmations stay centred because M50, M51 and M58 draw them that way. The spec text "confirmations rise as sheets" loses to the drawn screens. Section 6 lists this as an open question.

Sheet rules:

- `components/mobile/sheet.tsx` (new) holds `Sheet` and `SheetHeader`. The header is the kit's Sheet Header: handle 36 × 5, a 40 feature tile with a 20 icon, title 18/800, subtitle 13/500, close 36.
- Padding `pt-2 px-4 pb-[max(16px,var(--safe-bottom))]`, gap 16.
- `bottom: var(--kb, 0px)`, so a sheet with a field sits above the keyboard.
- `max-height: calc(var(--app-height) - var(--safe-top) - 8px)`. The top of a tall sheet is 8 px under the status bar (y 62 on the mock). The body scrolls. The foot actions stay fixed.
- Put the sheet classes after `className` in `cn(...)`, so a caller's `sm:max-w-*` cannot beat them.
- In sheet mode the absolute close X of `DialogContent` goes away. The Sheet Header has its own close.
- `DialogFooter` on mobile is `flex-col` (not reverse), buttons `h-12 w-full`. The primary or red button is the last child, so it sits at the foot. Check the DOM order of each footer call site.
- A sheet honours a controlled `onOpenChange` veto. A drag that the owner refuses snaps back. `RecoveryKeyDialog` needs this while a new key shows.
- Sheets stack above drawers (`z-50` over `z-40`). A second sheet replaces the first or stacks as a nested Radix dialog (M9 over M65).

Menus and popovers (`components/ui/dropdown-menu.tsx`, `components/ui/context-menu.tsx`, `components/ui/popover.tsx`):

- Each export switches to `components/mobile/menu-sheet.tsx` (new) on mobile. `MenuSheet` has the same API: Root, Trigger, Content (a sheet), Item (a 48 row that calls `onSelect` and then closes), Separator (a new group), Label (a Section Label), CheckboxItem, RadioGroup and RadioItem, and Sub (pushes inside the sheet).
- Item rows: icon 20, label 16/600, an optional hint 13 on the right (`data-slot="menu-hint"`, hidden in desktop menus). Destructive items are red in a red-tinted group.
- With this, the 9 dropdown and 7 context-menu call sites need no edits.
- The context-menu Trigger opens on `useLongPress` on mobile. Radix's own 700 ms touch timer is off.
- `PopoverContent` renders inside `Sheet` on mobile (pins, threads, profile, emoji, page picker). An `inline` prop keeps a small anchored popover.
- `components/ui/tooltip.tsx`: `mobile:hidden` on the content. The one `TooltipProvider` in `App.tsx` stays.

### 2.6 Pushed screens

- `components/mobile/pushed-screen.tsx` (new): `PushedScreen({ title, subtitle, onBack, action, foot, children })`. Safe top, Nav Bar 52, a square panel (`bg-surface-content border-t`, body padding 16, gap 10 to 16), an optional foot with one 48 primary, then the safe bottom.
- It slides in from the right when the depth goes up and out when it goes down. Focus moves to the nav title on push and back to the opener on pop.
- **No new navigation store.** The depth comes from `stores/navStore.ts`:
  - `navStore.settings` with section `null` = the settings list (M29). A set section = a pushed page.
  - `View.kind === 'page'` = the full-screen page (M38). The page pill and Back navigate to `{ kind: 'channel' }`, which clears the open page.
  - Back on the list calls `closeSettings()`. Back on a page calls `setSettingsSection(null)`.
- `setSettingsSection` accepts `null`. On desktop `resolveSection(null)` still shows the first section, so desktop does not change.
- Depth 2 inside a section (role editor, quiet hours) uses `ScreenStackProvider` and `usePushScreen()` from `components/mobile/pushed-screen.tsx`: React state, one level, not persisted.
- The inbox (M67) and search (M66) are local overlays that their own components own. They are not `navStore` views.
- A page registers the Nav Bar's right action through `NavAction` context (`components/mobile/nav-bar.tsx` (new)), for example "+ Create role" in M53.

### 2.7 Safe areas

- `apps/hachiman-ios/index.html` already has `viewport-fit=cover`. P4 adds `maximum-scale=1` as a second guard against focus zoom.
- The status bar (54) and the home indicator (34) are never drawn. The top uses `pt-(--safe-top)` on the tinted window. The bottom uses `pb-(--safe-bottom)` on the colour of the screen above it: content colour in the chat card, panel colour under a docked bar.
- `setAppearance({ theme, background })` (section 2.11) paints the native window behind both areas.

### 2.8 Keyboard

`hooks/use-visual-viewport.ts` (new), mounted once in `App.tsx`, so the gate screens get it too. On each `visualViewport` `resize` and `scroll`, it writes on `<html>`:

- `--app-height` = `visualViewport.height`
- `--kb` = `max(0, innerHeight - vv.height - vv.offsetTop)`
- `data-keyboard="open"` while `--kb` is over 80
- then `window.scrollTo(0, 0)`, because WKWebView scrolls the document to the focused field

It also exports `useKeyboardOpen()` and `useKeyboardInset()`.

Effects: the root has `height: var(--app-height)`, so the composer rides on the keyboard with no other code. With `data-keyboard=open`, the chat footer drops its safe-bottom padding and the voice bar hides. Sheets use `--kb`.

Focus rule: WKWebView raises the keyboard only for a `focus()` inside a user gesture. Call `focus()` synchronously in the tap handler (Reply in M5, Search in M66, Paste a link in M61). Do not use `autoFocus` on mobile fields that open from a sheet.

### 2.9 Long press and hold menus

- `hooks/use-long-press.ts` (new): `useLongPress(onFire, { ms = 400, slop = 8 })` over a pure state machine in `lib/long-press.ts` (new) with a test.
- It handles only `pointerType` `touch` and `pen`. It cancels on a move over 8 px, `pointerup`, `pointercancel` and scroll. On fire it calls `platform.haptic('light')`, then swallows the next `click` and the native `contextmenu`.
- iOS fires no `contextmenu` event. Do not depend on it.
- Targets get `mobile:select-none mobile:[-webkit-touch-callout:none]`. "Copy text" in the message sheet replaces text selection.
- **Hold on a sortable item** (tabs, guild tiles, channel rows, page tree rows): dnd-kit uses a `TouchSensor` with `{ delay: 400, tolerance: 8 }` on a coarse pointer, and a `MouseSensor` with `{ distance: 4 }`. `onDragStart` calls `haptic('light')`. A drag that ends with no move opens the hold menu (a controlled `open` on the context menu). A drag that moves reorders. So "hold and release" gives the menu and "hold and move" reorders. `hooks/use-sortable-row.ts` exports this as `useSortableHoldMenu`.
- Every hold-only action has a button path for VoiceOver: the sidebar and members buttons, an sr-only "Message actions" button per row, and "Move left / Move right" items in the tab and guild hold menus.

### 2.10 Touch sizes

| Thing | Size | Where it comes from |
|---|---|---|
| Any touch target | 36 or more | pad small visuals with an invisible hit area |
| Primary buttons | 48, full width | `Button size="mobile"` (`components/ui/button.tsx`) |
| Icon buttons | 36 | `IconButton size="touch"` (`components/ui/icon-button.tsx`) |
| Tabs | 34 in a 48 strip | `components/mobile/mobile-tab-strip.tsx` (new, A1) |
| Channel rows | 38 | `mobile:` height in `components/sidebar/sidebar-row.ts` |
| DM rows | 48 in the drawer, 58 on the DM home | `components/sidebar/dm-space.tsx` variants |
| Call controls | 52 | docked stage controls (B2) |
| List rows | 54, 46 for one line | `ListRow` |
| Nav bar | 52 | `NavBar` |
| Sheet rows | 48 | `MenuSheet` items |

The mocks break the 36 rule in many places: reaction chips 26, Retry 24, the tab close mark, the 22 × 20 "+" beside DIRECT MESSAGES and GUILDS, the category "+" 16, the row invite and settings icons 16, swatches 30 to 32, the M66 clear button 32, Play 32, the 18 checkbox. Keep the visual. Give each one a hit area of 36 or more, or make the whole row its label.

### 2.11 Native appearance

- `hooks/use-native-appearance.ts` (new) calls `platform.setAppearance({ theme, background })` when the resolved theme or the window colour changes, and only then.
- `App.tsx` mounts it with the default window colour, so the sign-in and gate screens get the right status bar. `MobileShell` passes the guild tint colour.
- `components/shell/use-guild-tint.ts` also returns the solid tint colour per theme (A1). The custom gradient gives its first stop.
- `apps/hachiman-ios/Hachiman/Native.swift` accepts only a hex colour. `tintColors()` returns `color-mix()` strings. `lib/css-color.ts` (new) resolves any CSS colour to `#rrggbb`: paint 1 px on a canvas and read `getImageData`. Check in the simulator that WebKit's canvas accepts a `color-mix()` fill. If it does not, compute the colour from the hue with OKLab math.

### 2.12 Smallest device: iPhone SE

The mocks are 393 × 852. The smallest phone that runs the app (iOS 18.5 or later) is the iPhone SE, 2nd and 3rd generation: **375 × 667**, with no notch. Every screen must fit and work on it.

- Safe areas on the SE: top 20 (the status bar), bottom 0 (a home button, no home indicator). The `--safe-top` and `--safe-bottom` variables give these values. Do not hard-code 54 or 34.
- Height budget on the SE: 667 − 20 = 647. The chat chrome takes tabs 48, header 56, voice bar 52 and composer 60, so 431 is left for messages. With the keyboard up (about 260 on the SE), the voice bar hides, and about 220 is left. Every screen must keep its primary action in view or scrollable to.
- Width: the 320 drawers leave 55 of the chat in view on the SE, not 73. Keep 320. Never let a drawer take more than `100vw − 48`.
- No horizontal overflow at 375. Rows truncate or wrap their text. Chip and tab strips scroll sideways. Two-column controls (for example the invite limits in M46) stack when they do not fit.
- Sheets and pushed screens scroll inside when their content is taller than the screen. The sheet header and the foot buttons stay in place.
- Touch sizes (section 2.10) do not shrink on the SE.
- **Check every screen at both sizes:** 393 × 852 (the mock) and 375 × 667 (iPhone SE). In the simulator use "iPhone SE (3rd generation)".

### 2.13 Rules that protect the desktop

- Shared components take mobile forms through `mobile:` classes, `useLayout()` in a named leaf, or a prop. Never through `useIsMobile()` inside desktop code.
- Extract logic into hooks so desktop and mobile share it. Keep the desktop JSX the same where possible.
- After each package, check desktop in `?preview` at a wide width and run the shared UI vitest.
- Zustand selector rules from CLAUDE.md apply to every new selector: single values, `useShallow` for objects, module-level empty constants.

## 3. Mobile kit to components

| Pen component | Shared UI component or variant | Sizes |
|---|---|---|
| Mobile / Status Bar (`AvCdy`) | not drawn: `--safe-top` | 54 on the mock |
| Mobile / Home Indicator (`r6WJK`) | not drawn: `--safe-bottom` | 34 on the mock |
| Mobile / Tab Strip (`rJ9Dt`) | `components/mobile/mobile-tab-strip.tsx` (new, A1) with the exported `Tabs` from `components/shell/tab-bar.tsx` | strip 48, padding-left 10, gap 8, toggle 36 with badge 17, divider 1 × 20, tabs 34 (padding 0/10/0/7, crest 18, icon 14, label 13.5), fade 24 |
| Arc / Pinned Tabs (`NxOB5`) | `Tabs` in `components/shell/tab-bar.tsx` | as above |
| Mobile / Voice Bar (`Q0wWD`) | `components/mobile/voice-bar.tsx` (new, A2) | 52, signal tile 30, title 13.5/800, line 12/500, timer chip 20, Mute and Deafen 36, Leave 42 × 36 |
| Mobile / Composer (`De0OR`) | `components/mobile/mobile-composer.tsx` (new, A6) | bar padding 8/12, attach 40, field 44 (text 16, not 15.5), E2EE chip 22, emoji 21, Send 40 |
| Mobile / Nav Bar (`J1oV5`) | `NavBar` in `components/mobile/nav-bar.tsx` (new, P2) | 52, padding 0/12/0/10, back 36, title 17/800, subtitle 12.5/500, action 36 |
| Mobile / Section Label (`u9pnuQ`) | `SectionLabel` in `components/mobile/list.tsx` (new, P2), on the existing `section-label` class | 11.5/800, tracking 0.8, padding 4/4/0/4 |
| List Group | `ListGroup` in `components/mobile/list.tsx` | `bg-white/2`, `border-line-hairline`, square, hairline dividers |
| Mobile / List Row (`o6y0O`) | `ListRow` in `components/mobile/list.tsx`: static or button, trailing chevron, value, switch, copy, external arrow, danger tone | 54 with a detail, 46 for one line, padding 0/14/0/12, tile 32 with icon 17, label 15/700, detail 12.5/500, value 13.5/600 |
| Mobile / Button · Primary (`Y9hYY`) | `Button variant="primary" size="mobile"` | 48, full width, r8, icon 18, label 15/800 |
| Mobile / Button · Secondary (`aUYX6`) | `Button variant="secondary" size="mobile"` | `--fill-control`, 1 px `#FFFFFF17`, 15/700 |
| Mobile / Button · Danger (`EXCAJ`) | `Button variant="danger" size="mobile"` | `feature-danger`, white 15/800 |
| Mobile / Button · Quiet (`yvBSC`) | `Button variant="quiet" size="mobile"` | no fill, `text-secondary` 15/700 |
| Mobile / Field (`x1Mbvl`) | `MobileField` in `components/mobile/field.tsx` (new, P3) over `Input`, `NativeSelect` and `Textarea` touch sizes | label 13/700, box 48 r8, lead icon 17, value 16, helper 12.5, focus stroke accent 70 % at 1.5 px, mono for codes and keys |
| Mobile / Sheet Header (`J3ZsL1`) | `SheetHeader` in `components/mobile/sheet.tsx` (new, P2) | handle 36 × 5, tile 40, title 18/800, subtitle 13/500, close 36 |
| Mobile / Keyboard (`tM9NS`) | not built: the OS keyboard | none |
| Template · Pushed screen (`n3TQN`) | `PushedScreen` in `components/mobile/pushed-screen.tsx` (new, P2) | nav 52, body padding 16, foot 48 |
| Arc / Toggle On / Off | `Switch size="touch"` (`components/ui/switch.tsx`) | 46 × 28, knob 22 (the row is the hit area) |
| Arc / Checkbox | `Checkbox size="lg"` (`components/ui/checkbox.tsx`) + a 44 label row | 18 |
| Radio cards (M16, M31, M47) | `RadioCard size="mobile"` with `badge` and `mark="foot"` (`components/ui/radio-card.tsx`) | padding 14, tile 40 / icon 20, title 15.5/800, radio 22, checked fill feature 7 % |
| Segmented control (M4, M22, M49) | `SegmentedControl size="touch"` (`components/ui/segmented-control.tsx`) | 44 group, r10, segments r8, text 14 |
| Callouts (M19, M20, M22, M25, M27) | `Callout` with `icon`, `action` and touch size (`components/ui/callout.tsx`) | title 14/800, body 13.5/500, padding 12/14, action row 44 |
| Chips (M24, M25, M28) | `Chip` (`components/ui/chip.tsx` (new, P3)), from the `Tag` in `components/security/devices-panel.tsx` | 20 high, 11/800, icon 11 |
| Role chips (M53, M54) | `RoleChip size="sm"` (`components/ui/role-chip.tsx`) | 22, dot 7, 12/700, no remove mark on mobile |
| Filter chips (M66, M67) | `FilterChips` in `components/mobile/filter-chips.tsx` (new, P2) | 36, padding 0/12, 13.5/700, optional count and chevron |
| Docked foot | `MobileFoot` in `components/mobile/foot.tsx` (new, P2) and `SaveBar layout="foot"` (`components/settings/save-bar.tsx`) | padding 12/16/4/16, one 48 primary, `--safe-bottom` |

## 4. Work packages

### 4.1 How to read the packages

- Each package fits one agent. It owns the files in its **Owns** list. No other package in the same wave edits those files.
- A file can move from one package to a later one ("takes over from"). The waves are in order, so the edits never run at the same time.
- **Check** lists what to look at. "Preview" means the browser host in dev with `?preview`, in a 393 × 852 touch viewport (devtools device mode). "Simulator" means the iOS app on the iOS 17 simulator (`pnpm -F @hachiman/hachiman-ios build`, `xcodegen generate`, run from Xcode). Every package also runs `tsgo` typecheck and the shared UI vitest, and checks the desktop at a wide width.
- The preview fixture (`dev/preview/fixture.ts`, `dev/preview/fixture-pages.ts`) already has the B1 data: Night Owls, Lattice Labs, marlowe, Juni, the Lounge call, the pinned tabs and `#design-pages`.

### 4.2 Waves

| Wave | Packages (run in parallel) |
|---|---|
| W0 | P1, P2, P3, P4, P5 |
| W1 | P6, A1, C1, C2 |
| W2 | A2, A3, A4, A5, B1, E1 |
| W3 | A6, I1, I2, B2, C3, D1, E2, E4, G1, G3 |
| W4 | E3, D2, D3, G2a, H1, H2, H3, I3, J3, J4, F1 |
| W5 | H4, J1, J2, F2 |
| W6 | G2b, F3a, F3b |

The plan's order of value still holds: rows A and B first, then C (sign in on a phone), and the page editor last. The waves only add the file rules on top.

### 4.3 Foundation packages

#### P1 · Layout switch, tokens, viewport and appearance

- **Screens:** none. The base for all.
- **Owns:** `hooks/use-layout.ts` (new), `hooks/use-visual-viewport.ts` (new), `hooks/use-native-appearance.ts` (new), `lib/css-color.ts` (new), `assets/main.css`, `App.tsx`, `components/ui/tooltip.tsx`.
- **Work:**
  - Section 2.2 switch, `data-layout` on `<html>`, the `mobile` custom variant and the base CSS.
  - All tokens of section 2.1 in both modes.
  - `App.tsx`: the root height `h-(--app-height,100dvh)`. Mount `useVisualViewport` and `useNativeAppearance` (default window colour). Keep rendering `Shell` on both layouts. A1 adds the branch.
  - `components/ui/tooltip.tsx`: `mobile:hidden` on the content.
- **Native hooks:** `setAppearance` (exists in the seam).
- **Check:** Preview at 393 wide shows `data-layout="mobile"` on `<html>`. At 1280 it shows `desktop`. In the simulator, focus any input: no page zoom, `--kb` is over 80 and `data-keyboard="open"` is set. Switch the theme: the status bar glyphs change.
- **Depends on:** nothing.

#### P2 · Mobile kit

- **Screens:** none.
- **Owns:** `components/mobile/sheet.tsx` (new), `components/mobile/nav-bar.tsx` (new), `components/mobile/pushed-screen.tsx` (new), `components/mobile/list.tsx` (new), `components/mobile/foot.tsx` (new), `components/mobile/filter-chips.tsx` (new), `hooks/use-long-press.ts` (new), `lib/long-press.ts` (new), `lib/long-press.test.ts` (new).
- **Work:** the kit pieces of section 3 with the values there. `Sheet` sits on Radix Dialog (focus trap, `aria-modal`, Escape), with the handle drag, the veto snap-back and `--kb`. `PushedScreen` with `ScreenStackProvider`, `usePushScreen` and the push animation. `NavBar` with the `NavAction` context. `FilterChips` as a sideways scroller with `aria-pressed` or `radiogroup`. `useLongPress` per section 2.9.
- **Check:** `lib/long-press.test.ts` covers fire, slop cancel, scroll cancel and click swallow. Visual checks happen in the first consumer (A1, A3, E1).
- **Depends on:** nothing. The kit is mobile-only, so it needs no `mobile:` variant. It uses the token names of section 2.1 through `var()`.

#### P3 · Touch sizes of the ui primitives

- **Screens:** none.
- **Owns:** `components/ui/button.tsx`, `components/ui/icon-button.tsx`, `components/ui/switch.tsx`, `components/ui/segmented-control.tsx`, `components/ui/radio-card.tsx`, `components/ui/checkbox.tsx`, `components/ui/callout.tsx`, `components/ui/input.tsx`, `components/ui/native-select.tsx`, `components/ui/textarea.tsx`, `components/ui/role-chip.tsx`, `components/ui/field.tsx`, `components/ui/chip.tsx` (new), `components/mobile/field.tsx` (new).
- **Work:** add the variants of section 3. Change no default. `Input`, `NativeSelect` and `Textarea` touch sizes use 16 px text and a lead-icon slot. `RadioCard`: `size="mobile"`, `badge`, `mark="foot"`, and the feature tint on the checked card. `Callout`: `icon`, `action ({ label, href | onClick })`, touch size. `Chip`: tones accent, voice, event, danger, neutral.
- **Check:** desktop pages that use these primitives look the same (settings, onboarding, devices). A scratch render of each new size at 393 wide.
- **Depends on:** nothing. The new sizes are prop variants, not `mobile:` classes.

#### P4 · iOS host native changes

- **Screens:** none. It supports the long press, the keyboard, the page toolbar and the file picker of row A, F and J.
- **Owns:** `apps/hachiman-ios/index.html`, `apps/hachiman-ios/Hachiman/WebView.swift`, `apps/hachiman-ios/Hachiman/Info.plist`, `apps/hachiman-ios/src/probe.ts`.
- **Work:**
  - `apps/hachiman-ios/index.html`: add `maximum-scale=1` to the viewport.
  - `apps/hachiman-ios/Hachiman/WebView.swift`: `allowsLinkPreview = false`. A `WKUIDelegate` `contextMenuConfigurationForElement` that returns nil. `scrollView.bounces = false` (inner scrollers keep momentum). Hide the form input accessory bar (prev, next, Done) by overriding `inputAccessoryView` of the content view. Keep `allowsBackForwardNavigationGestures = false`.
  - `apps/hachiman-ios/Hachiman/Info.plist`: add `NSPhotoLibraryUsageDescription` (file input picker, M61, M30).
  - `apps/hachiman-ios/src/probe.ts`: report `navigator.clipboard.writeText` and `readText` under `hachiman://app`, and `ClipboardItem` with a promise.
- **Check:** in the simulator, hold a link in a message: no WebKit preview. Focus the composer: no accessory bar over the keyboard. The page does not rubber-band.
- **Depends on:** nothing. The accessory-bar override uses a private view class. Section 6 lists the App Review risk.

#### P5 · `saveTextFile` seam

- **Screens:** none. It supports "Save to Files" in rows C and D.
- **Owns:** `shared/IPlatformService.ts`, `apps/hachiman-browser/src/platforms/browser/PlatformService.ts`, `apps/hachiman-electron/src/renderer/src/PlatformService.ts`, `apps/hachiman-ios/src/platforms/ios/PlatformService.ts`, `apps/hachiman-ios/Hachiman/Bridge.swift`, `apps/hachiman-ios/Hachiman/Native.swift`, `docs/gateway-protocol.md` (§11 only).
- **Work:** `saveTextFile: ((name: string, text: string) => Promise<boolean>) | null`. iOS: a bridge op that writes a temp file, presents `UIDocumentPickerViewController(forExporting:asCopy:)`, and deletes the temp file. Browser and Electron: `null`, and the UI keeps the blob download. Contract §11 in the same change. These host files already carry uncommitted Phase 4 changes. Build on them.
- **Check:** in the simulator a test call opens the Files export sheet and saves a `.txt` file.
- **Depends on:** nothing.

#### P6 · Dialogs, menus and popovers as sheets

- **Screens:** none of its own. It carries rule 06 for every sheet screen.
- **Owns:** `components/ui/dialog.tsx`, `components/ui/modal-window.tsx`, `components/ui/confirm-dialog.tsx`, `components/ui/dropdown-menu.tsx`, `components/ui/context-menu.tsx`, `components/ui/popover.tsx`, `components/mobile/menu-sheet.tsx` (new), `components/chat/attachments/lightbox.tsx`.
- **Work:** section 2.5. `ModalWindow` on mobile renders `SheetHeader`, a scrolling body and `actions` as a stack of 48 buttons, primary last. `ConfirmDialog` passes `presentation="dialog"` and gets the two-column mobile footer and an optional `description`. `components/chat/attachments/lightbox.tsx` uses `presentation="fullscreen"`. `MenuSheet` per section 2.5, with a controlled `open` for the sortable hold menus.
- **Check:** in Preview at 393 wide, open "Create channel", "Invite people", "Leave guild" and a message "More" menu. The first two rise as square sheets with a handle. "Leave guild" is centred with Cancel and the red button side by side. The menu is a sheet of 48 rows. The desktop look at 1280 is unchanged.
- **Depends on:** P1, P2, P3.

### 4.4 Row A · Main chat and drawers

#### A1 · Mobile shell, drawers and tab strip

- **Screens:** M2 (sidebar open). The frame for every chat screen.
- **Owns:** `components/mobile/mobile-shell.tsx` (new), `components/mobile/drawer.tsx` (new), `components/mobile/drawer-state.ts` (new), `components/mobile/use-swipe.ts` (new), `components/mobile/mobile-tab-strip.tsx` (new), `components/mobile/mobile-chat-pane.tsx` (new, A1), `components/mobile/settings-host.tsx` (new, A1), `components/mobile/page-screen.tsx` (new, A1), `lib/swipe.ts` (new), `lib/swipe.test.ts` (new), `lib/mobile-drawer.ts` (new), `lib/mobile-drawer.test.ts` (new), `App.tsx` (from P1), `hooks/use-app-shortcuts.ts`, `components/shell/shell.tsx`, `components/shell/sidebar.tsx`, `components/shell/tab-bar.tsx`, `components/shell/use-guild-tint.ts`, `components/people/right-column.tsx`, `stores/unreadStore.ts`.
- **Work:**
  - `MobileShell` per section 2.3 and both drawers per section 2.4.
  - Left drawer slots: controls = a 36 close button (`panel-left-close`) + `InboxButton` + `MeButton`. No back, forward or ⌘K. Top = `SwitcherField` + `SidebarRows`. Middle = `GuildChannelList` or `DmSpace`. Foot = `VoiceDock`. `Sidebar` gets `className`: `w-full px-3 pt-[calc(var(--safe-top)+2px)] pb-(--safe-bottom)`.
  - `components/people/right-column.tsx`: `variant="drawer"` (full width, no border, no resize handle, never wide). The tab `SegmentedControl` uses `size="touch"` in the drawer (M4). In the drawer, a page that the Pages tab opens navigates to `{ kind: 'page' }` instead of `openBeside`.
  - `hooks/use-app-shortcuts.ts`: an optional `onSidebar` argument. `MobileShell` passes one that toggles the left drawer. Desktop passes nothing and keeps `toggleSidebar()`.
  - `components/mobile/mobile-chat-pane.tsx`: a fallback that renders today's `ChannelPane` with `ChatBody`, `VoiceRoom`, `DmCallPanel`, `HomePane` or `NoChannelPane`, as `components/shell/shell.tsx` does. A2 takes it over.
  - `components/mobile/settings-host.tsx`: a fallback that renders today's `SettingsPage` in a `PushedScreen` while `useSettingsMode()` is set. E1 takes it over.
  - `components/mobile/page-screen.tsx`: a fallback that renders `PagesPanel` in a `PushedScreen` for a `{ kind: 'page' }` view. F2 takes it over.
  - `MobileTabStrip`: toggle 36 with the `useAllUnread()` badge, divider, the exported `Tabs` in a `data-swipe-ignore` scroller with a 24 px `mask-image` fade, `PinCurrent` and "+" (`openSwitcher('pin')`).
  - `components/shell/tab-bar.tsx`: export `Tab`, `Tabs`, `PinCurrent`, `TabIcon` and `Crest`. Scroll the active tab into view when the active index changes and is 0 or more (`inline: 'nearest'`). On mobile the close mark on the active tab goes (hold to unpin).
  - `components/shell/shell.tsx`: export `WALLPAPER` and `useDefaultChannel()`. No behaviour change on desktop.
  - `components/shell/use-guild-tint.ts`: also return the solid window colour per theme for `useNativeAppearance`.
  - `stores/unreadStore.ts`: export `useAllUnread()` on the private `useBadgeSum` with a stable match-all function.
  - `App.tsx`: the layout branch.
- **Native hooks:** `setAppearance` with the guild tint.
- **Check:** Preview at 393 × 852: the chat fills the screen under the tab strip. Tap the sidebar button: the drawer slides over in 250 ms, the chat does not move, 73 px of chat shows under the scrim. Swipe from the left edge: the drawer follows the finger and snaps. Tap a channel: the drawer closes on that channel. Tap a guild tile: the drawer stays open on the new guild's channels. Swipe left in the chat: the members drawer. Escape closes a drawer. While a pushed screen shows, the chat card and the closed drawers are `inert` (`useChatCovered()`): VoiceOver swipe and Tab stay in the screen (`PushedScreen` makes only itself inert). Check M12's frame in light mode (35 % scrim). In the simulator, switch guilds: the area behind the status bar takes the tint.
- **Depends on:** P1, P2.

#### A2 · Chat pane: header, voice bar and footer

- **Screens:** M1 (#general), M11 (#general light).
- **Owns:** `components/mobile/mobile-chat-pane.tsx` (from A1), `components/mobile/mobile-channel-header.tsx` (new, A2), `components/mobile/voice-bar.tsx` (new), `components/mobile/channel-info-sheet.tsx` (new), `components/mobile/mobile-chat-footer.tsx` (new, A2), `lib/media-caps.ts` (new), `components/shell/channel-pane.tsx`, `components/chat/chat-body.tsx`, `components/chat/typing-line.tsx`, `components/voice-connected-panel.tsx`, `components/threads/threads-button.tsx`, `components/pins/pins-button.tsx`, `components/notify/notify-menu.tsx`.
- **Work:**
  - `MobileChannelHeader` (56, padding 0/10/0/16, gap 6). Title stack as a button: line 1 icon 18, name 17/800, chevron 14 and the chips. Line 2 the topic 12.5/500. Branches: text (Threads chip, Pins chip, members 36), voice (Volume2 icon, line 2 = `VoiceHeaderMeta`, `VoiceHeaderExtras` as "Verify", members 36), DM (the existing `DmTitle`, `DmTrustChip`, `DmCallButton`. I2 refines it).
  - `components/shell/channel-pane.tsx`: export `ChannelTitle`, `DmTitle`, `DmTrustChip` and `HeaderChip`. Desktop does not change.
  - `ChannelInfoSheet` behind the title: the notify level options from `components/notify/notify-menu.tsx` (export `NOTIFY_LEVELS` and `LEVEL_ICON`, which are module-private today), Pin to tabs, Channel settings (pushes M48). The bell and gear leave the mobile header.
  - Threads and Pins chips: `h-9 px-[9px] [&_svg]:size-[17px]`. Their lists open as sheets through P6.
  - `components/chat/chat-body.tsx`: split `ChannelChat` into `useChannelChat(channel)` and two footers. The desktop footer keeps `--dock-inset` and `--dock-height`. The mobile footer is `MobileChatFooter`: `TypingLine` (22, `pl-4`), `VoiceBar`, today's `Composer` (A6 replaces it), then `--safe-bottom`. `components/chat/typing-line.tsx` takes a `className`.
  - `MobileChatFooter` puts `data-slot="chat-footer"` on its root. `components/mobile/mobile-chat-footer.tsx` exports `focusComposer()`: a synchronous `document.querySelector('[data-slot=chat-footer] textarea')?.focus()`. A tap handler calls it, so the keyboard rises (section 2.8). Today `Composer` focuses on reply in an effect, which is outside the gesture. A3 (Reply) and J1 (Paste a link) call `focusComposer()`. A6 keeps the selector working.
  - `VoiceBar` per section 3. It reuses `SelfVoiceToggles`, `voiceService.leaveVoice`, `CallTimer`, `phaseOf` and `PHASE` (export them from `components/voice-connected-panel.tsx`). Tap outside the buttons opens the call's channel or DM. It hides while the keyboard is open and on the call's own stage.
  - `components/voice-connected-panel.tsx`: buttons `h-9` on mobile. Render `ScreenShareControls` only when `canShareScreen()` (`lib/media-caps.ts`: `typeof navigator.mediaDevices?.getDisplayMedia === 'function'`). No camera button.
  - M11: use tokens only. Check every piece in light mode against M11.
- **Native hooks:** `haptic('light')` on mute and deafen (optional).
- **Check:** Preview, #general in Night Owls: header 56 with two lines, Threads "3" and Pins "4" chips, members button. Tap the title: the channel sheet. Join Lounge: the voice bar shows "Voice connected · Lounge · Night Owls" with the timer. Tap it: the Lounge stage. Light theme: compare with M11. In the iOS simulator the drawer dock has no Share Screen button.
- **Depends on:** A1, P6.

#### A3 · Long press and the message action sheet

- **Screens:** M5 (long press).
- **Owns:** `components/chat/message-row.tsx`, `components/chat/message-toolbar.tsx`, `components/chat/message-more-items.tsx`, `components/chat/transcript.tsx`, `components/chat/emoji-picker.tsx`, `components/chat/message-actions.ts` (new), `components/mobile/message-action-sheet.tsx` (new), `components/mobile/quick-reactions.tsx` (new), `components/chat/reactions.tsx`.
- **Work:**
  - `components/chat/reactions.tsx`: the reaction chips and "Add reaction" keep their drawn size (28) and take a 36 hit height on the mobile layout, with gaps that keep two hit areas apart.
  - `useMessageActions(message, policy)` returns `{ id, label, icon, tone, hint, run }` for react, reply, thread, copy, pin, edit, delete and info. The desktop toolbar and the More menu render the same list. Desktop does not change.
  - Mobile rows: no `MessageToolbar` (`focus-within` would show it after a tap). Force the cozy display. Rows `mx-1 px-3 py-2 rounded-[9px]`, `select-none [-webkit-touch-callout:none]`, `useLongPress` on the row but not on links, audio controls, Retry, Delete or reaction chips. An sr-only "Message actions" button per row.
  - `MessageActionSheet`: a lift scrim (`--surface-scrim-lift`), an `inert` clone of the row that starts at the row rect and moves to 12 px above the sheet (long messages clamp with a fade), quick reactions, then action groups: Reply, Create thread, Copy text, Pin (hint "n pinned"), Edit, Delete (my messages), and Info. Delete opens a confirm that names the message in bold with the red button last. A pending or failed row offers only Copy and Delete.
  - Quick reactions: 6 emoji from `prefsStore.recentEmojis`, topped up with defaults, plus "smile-plus". My reactions are lit. A tap toggles through `transcript-actions` and closes. "smile-plus" opens `EmojiPicker` in a sheet. `components/chat/emoji-picker.tsx` gets an `autoFocusSearch` prop that is false here, so the keyboard does not rise.
  - A tap on the lift scrim or on the lifted row closes the sheet (behaviour spec "tap outside to dismiss"), as Escape and the handle swipe do.
  - Reply: `setReplyTarget`, then `focusComposer()` (A2) synchronously in the tap handler.
  - Copy text: plain text with wire forms turned back into display text, as `components/chat/message-summary.ts` does. `useCopy` feedback.
  - `EditBox` on touch: Save and Cancel buttons instead of the key hint line.
  - `components/chat/transcript.tsx`: `useMarkRead` also listens to `visibilitychange` and pauses while `useChatCovered()` is true. "Jump to present" sits above the voice bar.
- **Native hooks:** `haptic('light')` when the hold completes. P4 turns off WebKit link previews.
- **Check:** Preview, hold Juni's reply for 400 ms: the row lifts under a darker scrim and the sheet rises. Move 10 px during the hold: nothing opens. Flick-scroll: nothing lifts. Tap 🎮: the reaction toggles. Tap Reply: "Replying to Juni" and (in the simulator) the keyboard. Copy text gives "Copied". Play a voice message, then hold its row: the lifted copy stays silent. Desktop hover toolbar and More menu are unchanged.
- **Depends on:** A1, P2, P6.

#### A4 · Members drawer and profile sheet

- **Screens:** M4 (members).
- **Owns:** `components/member-list.tsx`, `components/people/member-moderation.tsx`, `components/user-profile-popover.tsx`, `components/mobile/member-sheet.tsx` (new).
- **Work:** rows 42, avatars 32, the 40 px bottom fade above the live cards. A tap on a member opens the profile as a sheet (popover through P6). A hold opens the member sheet: Message, Poke, the moderation items from `components/people/member-moderation.tsx`, Copy username. When a member has no voice activity and no custom status, show a presence line ("Idle", "Do not disturb" in coral). The touch-size tab control of the drawer is in A1 (`components/people/right-column.tsx`).
- **Native hooks:** `haptic('light')` on the hold.
- **Check:** Preview, open the members drawer: the drawer sits at x 73, groups and rows match M4, the live card stays pinned at the foot while the list scrolls. Tap quill: profile sheet. Hold quill: member sheet. Tap the live card: the Ranked queue view.
- **Depends on:** A1, P6.

#### A5 · Touch reorder and hold menus in the drawer and strip

- **Screens:** M3 (guild grid open), M12 (sidebar open, light), M36 (open a pages channel).
- **Owns:** `hooks/use-sortable-row.ts`, `components/shell/tab-bar.tsx` (from A1), `components/shell/tile-row.tsx`, `components/shell/sidebar-rows.tsx`, `components/sidebar/channel-row.tsx`, `components/sidebar/guild-channels.tsx`, `components/sidebar/sidebar-row.ts`, `components/events/event-row.tsx`.
- **Work:**
  - `hooks/use-sortable-row.ts`: coarse-pointer sensors and `useSortableHoldMenu` (section 2.9). `touch-action: manipulation` on draggables.
  - Tabs: hold and release gives a menu with Unpin, Move left and Move right. Hold and move reorders (`tabsStore.moveTab`).
  - Guild tiles: hold shows the name bubble (a controlled `Tooltip` while held, side bottom). Hold and move reorders (`setGuildOrder`). Hold and release gives the guild menu. Swallow the click after a hold. Give the "+" beside GUILDS a 36 hit area.
  - Rows: channel rows 38 (`mobile:h-[38px]`, text 15, icon 18), category rows 36, voice participant rows 36 (avatar 22, `pl-[34px]`). The mock draws both at 32, but each row is a button and the rows touch, so only the row height can give the 36 touch size (section 2.10). On touch only the selected row shows invite and settings, with 36 hit areas. A 36 px bottom fade on the channel list. Event row 38.
  - M36: a pages channel row gets the violet icon (`text-feature-page`) and `<SystemTag kind="page"/>`, also when selected. This also fixes desktop C1. On mobile a channel row tap calls `navigate({ kind: 'channel', guildId, channelId })`, so a pages channel opens on its chat, not on the page.
  - M12: in light mode, the tile cutouts (`LIT_BG` in `lib/sidebar-tiles.ts`) must match the drawer tint. Check, and fix in `components/shell/tile-row.tsx` with a transparent-safe ring.
- **Native hooks:** `haptic('light')` at every hold and drag pick-up.
- **Check:** Preview: swipe the tab strip sideways: it scrolls and no drag starts. Hold a tab and release: the tab menu. Hold and move: reorder. Open the cluster tile in the drawer: the grid unfolds 5 to a line. Hold Film Night: the name bubble and a haptic in the simulator. Scroll a long channel list as a manager: no channel drag starts. Tap `#design-pages`: the chat opens, not the page. Light mode drawer matches M12.
- **Depends on:** A1, P6.

#### A6 · Composer and keyboard

- **Screens:** M6 (typing a mention).
- **Owns:** `components/chat/composer.tsx`, `components/chat/use-composer.ts` (new, A6), `components/chat/mention-menu.tsx`, `components/mobile/mobile-composer.tsx` (new), `components/mobile/mobile-chat-footer.tsx` (from A2).
- **Work:**
  - Move the composer state and handlers into `components/chat/use-composer.ts`. `Composer` keeps the desktop markup.
  - `MobileComposer`: Attach 40 outside the field (one file input, so iOS offers Photo Library, Take Photo and Choose Files), field 44 with a 16 px textarea up to about 5 lines, the E2EE chip and the emoji button (emoji sheet). Send (accent, arrow-up) shows when there is text or an upload. With no text the right slot is empty. Return adds a newline. `autoCapitalize="sentences"`, `autoCorrect="on"`, `enterKeyHint="enter"`, `caret-color: var(--accent-primary)`.
  - `components/chat/mention-menu.tsx`: on mobile a full-width square popover above the composer row (x 8, width minus 16), max height = the space above the composer. A header row with the scope ("MEMBERS · Night Owls") and the trigger char. Rows 46: avatar 32, role-ink name, crown for the owner, activity line, highest role name on the right. Picks use `onPointerDown` with `preventDefault` plus `onClick`, and the textarea `onBlur` clear waits about 150 ms.
  - `MobileChatFooter` swaps in `MobileComposer`.
- **Native hooks:** P4 hides the accessory bar. Optional later: a native keyboard-frame event for smoother tracking.
- **Check:** Simulator: tap the field: the keyboard rises, the composer sits on it, the voice bar hides, no zoom. Type "@ma": the popover shows marlowe first. Tap marlowe: "@marlowe " is inserted. Send sends and clears. Drag the transcript down: the keyboard closes. Desktop: Enter still sends.
- **Depends on:** A2, P1.

### 4.5 Row B · DMs, voice and light theme

M7 is in I2. M8 is in I1. M11 is in A2. M12 is in A5.

#### B1 · Verification sheet

- **Screens:** M9 (verify marlowe).
- **Owns:** `components/security/verification-dialog.tsx`, `components/security/qr-view.tsx`.
- **Work:**
  - Move the state and actions into `useVerification(userId)`. The mobile order: intro text, the 60 digits, "THEIR DEVICES · n", the note, a "Show your code instead" row that expands `QrCodeView` inline (max 240), then the foot: Secondary "Scan their code", Primary "The numbers match — mark as verified". "Remove verification" (quiet) when verified. "Accept the new key without a check" when the key changed. No Done button on mobile.
  - Digits box: 21/500 mono, `justify-between`, `px-[18px] py-4 gap-y-2.5`, an `aria-label` per row so VoiceOver reads groups.
  - `components/security/qr-view.tsx`: split `ScanOrPaste` into `useScanOrPaste({ prefix, onCode })` and the desktop view. `canScan` = `platform.scanQr !== null` or `BarcodeDetector`. A native result is checked against the prefix. Null is a cancel. The paste field stays as a fallback behind "Paste the code text instead".
  - Device rows show the platform icon and per-user trust chip. They hide the OS label and fingerprint lines (section 5).
- **Native hooks:** `scanQr`, `haptic('success')` on verified or a match, `haptic('warning')` on a mismatch.
- **Check:** Simulator: open marlowe's DM, tap the trust button: the sheet rises from y 62 over a 72 % scrim. "Scan their code" opens the native scanner. Cancel returns with no error. On an iPhone SE size the body scrolls and both buttons stay at the foot.
- **Depends on:** P6, P3.

#### B2 · Voice stage and verify call

- **Screens:** M10 (Lounge voice), M65 (verify call).
- **Owns:** `components/voice/voice-room.tsx`, `components/voice/voice-tile.tsx`, `components/voice/voice-tile-styles.ts`, `components/voice/voice-header.tsx`, `components/voice/screen-share-controls.tsx`, `components/voice/dm-call.tsx`, `components/voice/verify-call-dialog.tsx`.
- **Work:**
  - Stage on mobile: `p-3 gap-2.5`, at most 2 columns, square rows in a vertical scroller past 4 people. Tile: avatar 80, name pill 28, badges 28. Speaker: 2 px voice border, voice 8 % fill, 3 px ring.
  - `ControlBar` docked: `border-t px-4 py-3 gap-2.5`, toggles 52 (icons 21), Leave `flex-1 h-[52px]` danger with the label. No Share (`components/voice/screen-share-controls.tsx` returns null without `getDisplayMedia`). No camera. Soundboard moves into a "More" sheet button on the bar.
  - `components/voice/voice-header.tsx`: mobile label "Verify" ("Securing…" while not ready) at `h-9`. Line 2 "4 in call · Europe (West)". The W2 integration already gives `VoiceHeaderExtras` the "Verify" and "Securing…" labels and the 36 size on mobile.
  - Tiles: tap = profile sheet with `UserAudioControl`. Hold = member sheet.
  - `components/voice/dm-call.tsx`: on mobile a DM with my call shows the voice bar. The bar opens a full-height stage for the DM.
  - `components/voice/verify-call-dialog.tsx`: drop the inner scroller on mobile, rows 50 with avatars 32, "Safety number" at `h-9`, the gold "JOINING" group, Section Labels. The code stays 30 digits in 3 × 2 groups. Announce a code change in an `aria-live` region.
- **Native hooks:** `apps/hachiman-ios/Hachiman/AudioSession.swift` while in a call (exists). `haptic('light')` on mute and deafen (optional).
- **Check:** Preview, join Lounge: 2 × 2 tiles, docked 52 controls, no Share button at 393 wide in the simulator. Tap "Verify": the sheet with 30 digits. Tap "Safety number": M9 stacks and returns.
- **Depends on:** A2, A4 (the member sheet), B1 (M9 stacks over M65), P6.

### 4.6 Row C · Sign in and set up

#### C1 · Welcome and sign-in

- **Screens:** M13 (welcome), M14 (Takusen sign-in), M15 (consent).
- **Owns:** `components/sign-in-screen.tsx`, `services/TakusenService.ts`, `apps/takusen/src/components/ui/input.tsx`.
- **Work:**
  - M13 mobile branch: content on the gradient window, no card. Mark 64 with a 34 glyph, title 30/800, the glow at the top left. The encryption note with three path rows (Link it, Restore it with LifeBuoy, Start new). The foot: the 48 primary "Sign in with Takusen", the helper, and the error text above the button. Footer links Help, Privacy and Status to `${issuerOrigin}/#help`, `/#privacy` and `/#status`, each 44 tall, `target="_blank"`.
  - M14 and M15 are Takusen pages inside `ASWebAuthenticationSession`. The shared UI does not draw them. iOS draws the sheet chrome and a system consent alert. The mock chrome is illustration only.
  - `services/TakusenService.ts`: map `error=access_denied` to "You cancelled the sign-in."
  - Takusen `apps/takusen/src/components/ui/input.tsx`: `max-sm:text-base`, so Safari does not zoom on focus.
- **Native hooks:** `oauth.begin` (exists), external links through `apps/hachiman-ios/Hachiman/WebView.swift` (exists).
- **Check:** Simulator: M13 layout. Tap sign in: the system alert, then the Takusen page. Cancel: M13 stays and the button works again. Deny on consent: "You cancelled the sign-in."
- **Depends on:** P1, P3.

#### C2 · Set-up gate: choose, link and done

- **Screens:** M16 (set up this phone), M17 (link this phone), M21 (set up done).
- **Owns:** `components/security/onboarding.tsx`, `components/security/onboarding-steps.ts`, `components/security/screen-window.tsx`, `components/security/link-new-device.tsx`, `components/security/sas-emoji.tsx`, `components/security/setup-screens.tsx` (new), `components/security/setup-done.tsx` (new).
- **Work:**
  - `components/security/screen-window.tsx`: a step layout context (`'dialog' | 'screen'`). On `'screen'`, `StepFrame`, `StepHeader`, `StepBody` and `StepFooter` render `NavBar` (with `onBack`), body and foot instead of `DialogHeader` and `DialogTitle`. On mobile `OnboardingScreen` and `CryptoGate` render the step in a `PushedScreen` frame, not in a Dialog. The "Starting encryption" and start-error frames use the same frame.
  - M16: a native radio group of three `RadioCard size="mobile"` in the order link, restore, setup. The default and the RECOMMENDED badge follow `useAccountFacts` (Link when a master key exists or facts load, Restore after a password reset, Start new when no master key). Set the default once. The primary label follows the pick. The quiet reset line shows only when `facts.passwordReset` (then M20) or when a master key exists (then a sheet with the admin text). The help action opens a sheet with the paths and "Sign out". Phone titles through a device-noun helper in `components/security/onboarding-steps.ts`.
  - M17: extract `useNewDeviceLink()` (new) from `LinkAsNewDevice` in `components/security/link-new-device.tsx`. Desktop keeps `LinkAsNewDevice` on the hook. Start the QR session from the M16 tap, or guard it with a ref (all hosts use StrictMode). A 200 px white QR tile. A countdown "Code works for 9:48" from the start time plus `LINK_SESSION_TTL_MS`, in its own small component, with "New code" at zero. Two numbered steps, the gold waiting line. "Compare emoji instead" calls `linkCancel` first, then starts SAS. Back cancels. Keep the "Show it only to your own device" line.
  - `components/security/sas-emoji.tsx`: `size="touch"` (glyph 38, word 13/700, rows of 4, 7 emoji as 4 + 3).
  - M21: extract `SetupDone` (new) from the "Encryption is set up on this device" card that `OnboardingFlow` draws inline today. A gate `onboarded` flag in `CryptoGate` keeps the gate on `SetupDone` after the state turns ready, until "Open Hachiman". The success card markup is shared with the desktop I1 frame.
- **Native hooks:** `haptic('success')` on link done and on M21, `haptic('warning')` on a failed link, `haptic('light')` on a radio pick (optional).
- **Check:** Simulator with a fresh account: M16 shows Start new as recommended. With a second account that has a key: Link is recommended and Start new is disabled with the hint. Link shows the QR at once. One pending device row exists on the server, not two. Desktop and Electron keep the Dialog flow.
- **Depends on:** P1, P2, P3.

#### C3 · Restore, new identity and reset

- **Screens:** M18 (restore), M19 (start a new identity), M20 (reset my keys).
- **Owns:** `components/security/onboarding.tsx` (from C2), `components/security/setup-screens.tsx` (from C2: the mobile set-up screens go here, not in `onboarding.tsx`), `components/security/recovery-key-view.tsx`.
- **Work:**
  - M18: the key field in mono 17/600, `rows={3}`, `autoCorrect="off"`, `spellCheck={false}`, `autoComplete="off"`, `enterKeyHint="done"`. The count is `typed / 55` (the real key is "HRK1-" plus 11 groups of 5, not the mock's 48). The Restore button rides on the keyboard.
  - M19 as one screen with two states. State A: the WHAT YOU GET rows, the caution callout with "Link instead", and "Make my keys". State B (after `setupFirstDevice`): no back, the key block, Copy and "Save to Files", one danger line about the key, the 44 confirm row, and "Set up this phone" enabled after the tick.
  - `components/security/recovery-key-view.tsx`: split `RecoveryKeyReveal` into `RecoveryKeyBlock` and `RecoveryKeyActions`. Desktop composes them as today. "Save to Files" uses `platform.saveTextFile` when it is not null, else the blob download. Hide it on iOS until P5 lands.
  - M20: the danger callout, the "HAVE YOUR RECOVERY KEY?" row to M18, the confirm row, the danger 48 button disabled until ticked with `aria-describedby`. After the reset, state B of M19.
- **Native hooks:** `saveTextFile`, `haptic('success' | 'warning')`.
- **Check:** Simulator: paste a valid key: the count turns green and Restore works from the keyboard "done" key. Make keys: Back hides, Save opens the Files sheet. Reset is reachable only after a password reset.
- **Depends on:** C2, P5.

### 4.7 Row D · Devices and keys

#### D1 · Link a new device sheet

- **Screens:** M22 (scan tab), M23 (compare emoji), M24 (device linked).
- **Owns:** `components/security/device-link-dialog.tsx`, `components/security/sas-emoji.tsx` (from C2), `components/security/fingerprint-box.tsx` (new), `components/security/device-tile.tsx` (new), `components/mobile/viewfinder.tsx` (new).
- **Work:**
  - Header tile `Link`, subtitle "From this iPhone" on iOS. The caution callout gets the title "A linked device reads everything". Method tabs as `SegmentedControl size="touch"`. No footer Cancel on mobile (Close cancels, the unmount effect still calls `linkCancel`).
  - Scan tab: a 264 px `Viewfinder` tile that launches `scanQr` (a live viewfinder inside the sheet is not possible, section 5). A one-line mono paste field with a clipboard lead icon. "Use this code" at the sheet foot.
  - SAS tab: opened from the "A new device asks to link" notice, accept the session at once (keys go only after `linkConfirmSas(true)`). Without a session id, pending sessions as List Rows. Quiet "They do not match", then primary "They match". A note under the panel.
  - Done: the success block, the new device card (`DeviceTile`, name, platform label, "Linked" chip) and the key-log line. `FingerprintBox` renders only when a fingerprint exists (section 5).
- **Native hooks:** `scanQr`, `haptic('success' | 'warning')`, clipboard read.
- **Check:** Simulator: Devices → Link a new device: the sheet. Scan opens the native scanner. A wrong QR shows "This is not the right kind of code" with Scan again. SAS shows 7 emoji as 4 + 3.
- **Depends on:** B1, C2, P6.

#### D2 · Devices screen and device sheet

- **Screens:** M25 (devices), M26 (device details sheet).
- **Owns:** `components/security/devices-panel.tsx`, `components/security/host-trust.tsx`, `components/security/devices-screen.tsx` (new), `components/security/device-sheet.tsx` (new).
- **Work:**
  - The devices section renders `DevicesScreen` on mobile: the intro, the web-trust callout, "YOUR DEVICES · n", rows as buttons (tile 40, name, "This device" chip, meta, chevron), the hint, and "Link a new device" at the foot. `DevicesDialog` (kind `devices`) on mobile opens settings on the devices section instead of a modal.
  - `DeviceSheet` with steps details, rename and sign-out in one sheet. Details: static List Rows "Last active" and "Added", the note, Rename (quiet), Sign out (danger, last). Extract `useRenameDevice` and the two sign-out bodies, so the desktop ConfirmDialogs share them. Swap the local `Tag` for `Chip`. The `Tag` is 18 high, 10.5/700, icon 12, and `Chip` is 20, 11/800, icon 11: if the desktop look must not change, add `Chip size="sm"` with the `Tag` values and use it on desktop.
  - `components/security/host-trust.tsx`: fix the iOS line (today it says "The desktop app runs its own code"). The new callout rule (any active browser device) is mobile-only unless desktop agrees (section 6). "Get the desktop app" links to `${issuerOrigin}/`.
- **Native hooks:** `haptic('warning')` when the sign-out step opens, `haptic('success')` after rename or revoke.
- **Check:** Simulator: Settings → Devices pushes M25. Tap a device: the sheet. Rename: the field sits above the keyboard. Sign out another device: the reason picker uses the iOS wheel.
- **Depends on:** D1, E1.

#### D3 · Recovery key and security log screens

- **Screens:** M27 (recovery key with the new key sheet), M28 (security log).
- **Owns:** `components/security/recovery-panel.tsx`, `components/security/recovery-key-view.tsx` (from C3), `components/security/security-log.tsx`.
- **Work:**
  - M27: the chip above the title, the helper above a 48 secondary at the foot. Extract `useRotateRecoveryKey()`. The new key sheet uses the mock copy. While the new key shows, the sheet cannot close (`dismissible={false}` and the veto snap-back). The reveal on mobile: 4-column mono grid, 48 Copy and Save buttons, the 36 confirm row.
  - M28: extract `useKtCheck()` and the timeline builder. The status card has no button. "Check now" sits at the foot. Timeline rows from `listDevices` (node 32, line, title, date). Show the "Yours" chip only after a check in this session returned ok. Keep the alert state.
- **Native hooks:** `saveTextFile`, `haptic('success' | 'warning')`.
- **Check:** Simulator: rotate the key: the sheet cannot be dragged down until "I saved" and Done. Check now gives a haptic and the "All clear" card.
- **Depends on:** C3, E1.
- **As built (W4):**
  - `SheetContent` and `DialogContent` take `dismissible={false}`: no drag, no Escape, no scrim close and no sr-only Close. `RecoveryKeyDialog` passes it while the new key shows.
  - The settings intro of the security log already says what the M28 footnote says, so the page has no footnote.

### 4.8 Row E · Settings

#### E1 · Settings framework and list

- **Screens:** M29 (settings list).
- **Owns:** `components/mobile/settings-host.tsx` (from A1), `components/mobile/section-tabs.tsx` (new), `components/settings/settings-list.tsx` (new), `components/settings/settings-screen.tsx` (new), `components/settings/settings-model.tsx`, `components/settings/save-bar.tsx`, `stores/navStore.ts`, `stores/navStore.test.ts`, `stores/dialogStore.ts`, `components/shell/dialogs.tsx`, `components/settings/sign-out-sheet.tsx` (new, E1).
- **Work:**
  - `components/settings/settings-model.tsx`: add `value`, `tint`, `detail` on items, `detail` on `danger`, `navSubtitle` and `layout: 'list' | 'tabs'` on the model. User and channel use `list`, guild uses `tabs`. Hide `keybinds` on mobile. Keep `advanced` as the last Help row. On mobile the user danger row opens `{ kind: 'signOut' }`.
  - `stores/dialogStore.ts`: add `{ kind: 'signOut' }`. `DIALOGS` in `components/shell/dialogs.tsx` is a `Record` over every kind, so E1 registers it in the same change: `components/settings/sign-out-sheet.tsx` starts as a fallback `ConfirmDialog` that calls today's `takusenService.signOut()`. E3 takes the file over and builds M35.
  - `components/mobile/settings-host.tsx` renders by target:
    - user: `SettingsList` at section `null` (profile header with avatar 52, name 19/800 and status chip, then the groups, a spacer, the red group last), `SettingsScreen` for a set section.
    - channel (M48 frame): the first section's body inline, then the other items as List Rows, then the danger row.
    - guild (M52 frame): Nav Bar + `SectionTabs` (36 tabs with counts, fill width up to 4, scroll beyond) + the panel. The danger row ends the first visible tab.
  - Every page body comes from its existing `render()`. Each page file branches on the layout itself (later packages). So `components/settings/settings-model.tsx` needs no edit per page.
  - `stores/navStore.ts`: `setSettingsSection(section: string | null)`, plus tests.
  - `components/settings/save-bar.tsx`: `layout="foot"`: sticky at the foot inside the form, the status line + Reset (36 hit area), then a 48 primary, `--safe-bottom`.
  - Tap a row: push. Back on the list: `closeSettings()`. Back on a page: `setSettingsSection(null)`. Close both drawers on open.
- **Native hooks:** none.
- **Check:** Preview: tap Me in the drawer: the drawer closes, M29 pushes in. Rows show values ("Dark", "3"). Tap Appearance: the page pushes. Back twice: the chat, at the same scroll position. Open guild settings from the guild menu: the tab layout. Desktop settings unchanged.
- **Depends on:** A1, P2, P3.
- **As built (W2):**
  - The model also has `navTitle` (the Nav Bar title) and `onStatus` (E3 sets it: the M29 status chip then opens the status sheet). The chip button keeps its 28 look and has a 36 hit height (an `::after` area), so that a near miss does not open My account under it. `SettingsPageSpec` also has `intro` and `navSubtitle`. With `intro`, `SettingsScreen` shows the page description as the intro paragraph (devices, recovery, security log, advanced). D2 and D3 must not show that paragraph again. `navSubtitle` is the Nav Bar subtitle of a page (devices: "n devices hold your keys", recovery and security log: the username).
  - `SaveBar layout="foot"` is opt-in per page. G3 (channel overview, channel permissions), H1 (guild overview) and H2 (roles) pass it on the mobile layout. Put the foot last in the form, at the full width of the form. The roles page must take `SaveBar` out of its own sticky row first.
  - `ListRow` has the `activity` tile colour (`--feature-activity`) for the Notifications row of E3.

#### E2 · My account and appearance

- **Screens:** M30 (my account), M31 (appearance).
- **Owns:** `components/settings/user/account.tsx`, `components/settings/image-field.tsx`, `components/settings/use-image-upload.ts` (new, E2), `components/settings/user/appearance.tsx`, `components/settings/user/text-size.tsx` (new), `stores/prefsStore.ts`, `components/theme-provider.tsx`, `components/chat/message-row.tsx` (from A3).
- **Work:**
  - M30 `AccountMobile`: banner 64 from `useUserBanner`, avatar 72 with a 28 camera badge (`ImageField variant="badge"`), name 20/800, a roles line (top role per guild, at most two). TAKUSEN ACCOUNT group: "Signed in with Takusen" (email or "Email not shared", opens `${issuerOrigin}/account`), "User ID" (mono, copy with a haptic), the note. Hide Colour, Display name, About and Save until the server has them (section 5).
  - `components/settings/image-field.tsx`: extract `useImageUpload` (pick, preview, upload, remove, abort, object URL revoke) into `components/settings/use-image-upload.ts`. Add `variant="badge"`.
  - M31 `AppearanceMobile`: theme as 3 radio cards with a `PhoneSwatch` preview, density as 2 cards with `TranscriptPreview`, then `TextSizeSection`. No Sidebar and no Background section on mobile.
  - `stores/prefsStore.ts`: persisted `messageTextSize` in 5 steps (13, 14, 15, 17, 19, default 15) with a safe merge.
  - `components/theme-provider.tsx`: write `--message-text-size` on `<html>`. `components/chat/message-row.tsx`: the body text uses `var(--message-text-size, 15px)`. Desktop stays at 15 by default.
  - `TextSizeSection`: a native `<input type="range">` with drawn ticks and `aria-valuetext`. Apply on release.
- **Native hooks:** `haptic('light')` per slider step, `haptic('success')` on copy.
- **Check:** Preview: theme cards switch live, status bar follows in the simulator. The slider changes the sample message and the transcript after release.
- **Depends on:** E1, A3.
- **As built (W3):**
  - `--message-text-size` applies only on the mobile layout (`mobile:` classes on the message body in `components/chat/message-row.tsx`). The desktop message text does not change, and a size set in a narrow browser window does not reach a wide one.
  - The pure logic is `MESSAGE_TEXT_SIZES`, `isMessageTextSize` and `mergePersistedPrefs` in `stores/prefsStore.ts`, tested in `stores/prefsStore.test.ts`.
  - With an image set, the camera badge of `ImageField variant="badge"` opens a Choose / Remove menu (a sheet on mobile). With no image, it opens the picker directly.
  - The text-size note has no Dynamic Type sentence (section 5). It reads "<Name> · <n> pt. Sets the size of message text."
  - The Takusen row tile is the `event` feature tile with a "T" glyph. No `takusen/*` tokens were added.
  - The M31 density cards apply on the phone: `components/chat/transcript.tsx` no longer forces cozy on mobile (this replaces the A3 rule).

#### E3 · Sign-out sheet, status sheet, notifications and privacy

- **Screens:** M33 (notifications), M34 (privacy and safety), M35 (sign-out sheet).
- **Owns:** `components/settings/sign-out-sheet.tsx` (from E1), `components/settings/status-sheet.tsx` (new), `components/settings/user/notifications.tsx` (new), `components/settings/user/privacy.tsx` (new), `hooks/use-blocked-users.ts` (new), `components/shell/me-button.tsx`, `components/shell/dialogs.tsx` (from E1), `components/home-pane.tsx` (from I1), `services/guild-features.ts`, `stores/userStore.ts`, `components/settings/settings-model.tsx` (from E1).
- **Work:**
  - M35: `SignOutSheet` (feature danger). The subtitle is the current device name. The "other devices" detail lists other active device names. With a recovery key the checkbox must be ticked. With no other device and no recovery key, the callout turns red. "View key" becomes "Recovery key" (pushes M27). Confirm runs `cryptoService.signOutDevice()`. If the Worker is not ready, only `takusenService.signOut()`. An offline failure shows inline, and the phone stays signed in. Only this confirm removes keys. The automatic sign-out paths stay on `takusenService.signOut()`.
  - Status sheet from the M29 status chip: four presence radio rows and "Set a status". `components/shell/me-button.tsx`: on mobile no ContextMenu, a tap opens settings and closes the drawer. Move `STATUSES` and `STATUS_LABEL` into the status sheet module.
  - M33: register `notifications` (mobile only, App group, `--feature-activity` tile). Today only GUILD OVERRIDES: one row per guild with the level label or "Muted", a tap opens `NotifySettingsDialog` as a sheet. One line says phone notifications come later.
  - M34: register `privacy` (mobile only). Today only BLOCKED · n with Unblock (44). `hooks/use-blocked-users.ts` moves the user resolution out of `components/home-pane.tsx` (both use it). `services/guild-features.ts` and `stores/userStore.ts` keep `createdAt` for "Blocked 3 Oct". The note says only what is true today: blocked people cannot DM you or poke you.
- **Native hooks:** `haptic('warning')` on the destructive tap.
- **Check:** Simulator: Sign out → tick → sign out: back at M13, and the keychain wrap key is gone. Airplane mode: inline error, still signed in. Unblock removes the row.
- **Depends on:** E1, I1.

#### E4 · Voice and audio settings

- **Screens:** M32 (voice and audio).
- **Owns:** `components/settings/user/voice.tsx`, `components/settings/user/sounds.tsx`.
- **Work:** `VoiceMobile`: input device as a `MobileField` select (iOS wheel). Hide the output row on iOS (no `setSinkId`, section 5). `MicCheck` unchanged with a 44 button, stopped on `pagehide` and `visibilitychange`. Noise suppression as one switch row (on = `rnnoise`, fallback `browser`, off = `off`). Hide input mode, sensitivity and quality on mobile. Sounds: a master row with switch and volume, then a `SOUND_ROWS` table that pairs events (mute and unmute, deafen and undeafen, join and leave), rows 44 with a round 32 play button in a 44 hit area. Hide the link to the keybinds section on mobile: E1 hides that section there, so the link would leave the user on the settings list.
- **Native hooks:** mic permission, `apps/hachiman-ios/Hachiman/AudioSession.swift`.
- **Check:** Simulator: the mic check shows a live meter. Background the app and return: no stuck meter. Toggle a paired sound row: both events change.
- **Depends on:** E1.

### 4.9 Row F · Pages

M36 is in A5.

#### F1 · Pages channel on its chat and the pages drawer

- **Screens:** M37 (#design-pages on its chat), M42 (pages in the right drawer).
- **Owns:** `components/mobile/page-bar.tsx` (new), `components/mobile/mobile-chat-pane.tsx` (from A2), `stores/tabsStore.ts`, `stores/tabsStore.test.ts`, `components/chat/channel-intro.tsx` (from I2), `components/people/right-column.tsx` (from A1), `components/docs/pages-tree-list.tsx` (new), `components/docs/page-tree-popover.tsx`, `services/docs/page-tree.ts`, `services/docs/page-tree.test.ts`.
- **Work:**
  - `ChannelPageBar` (60) under the header in a pages channel: tile 40, the open page or the first root, chevron (opens the drawer on Pages), "Open page" → `navigate({ kind: 'page' })`. The meta line shows "n pages" until a real last-edit exists (section 5).
  - The mobile header needs no change. In a pages channel it shows Pins and Members, because `ThreadsButton` does not render there (the contract allows threads only under text channels).
  - `components/chat/channel-intro.tsx` `GuildIntro`: a quiet "New page" button for members with SEND_MESSAGES. It creates the page and opens it.
  - `stores/tabsStore.ts` `activeIndex()`: a channel view lights a pinned page tab of the same channel when no exact tab matches. Add a test.
  - Right drawer in a pages channel: `PagesTreeList` (rows 40, disclosure, a session collapsed set, search over the channel's pages, hold menu with New sub-page, Rename, Move, Delete, touch drag to reorder or nest). `usePageTreeActions` comes out of `components/docs/page-tree-popover.tsx` for both. `services/docs/page-tree.ts` gets a collapsed filter with a test. A row tap closes the drawer and pushes the page.
  - Do not render Recently edited, Templates, Trash, per-row tags or editor meta.
  - `components/docs/page-tree-popover.tsx` (and `PagesTreeList`): replace the local 4 px `PointerSensor` with `useDragSensors()` and give each row `useSortableHoldMenu(id)` (`open` and `onOpenChange` on its `ContextMenu`, `longPress` on its `ContextMenuTrigger`), as A5 did for tabs and channel rows. Else a scroll of the page tree on a phone starts a drag.
- **Native hooks:** `haptic('light')` on hold and drag pick-up.
- **Check:** Preview, Lattice Labs → `#design-pages`: the chat with the violet bar, and the pinned page tab is lit. Tap "Open page": the fallback page screen. Swipe left: the drawer on Pages with the tree.
- **Depends on:** A2, A5, I2.

#### F2 · Page screen

- **Screens:** M38 (the page).
- **Owns:** `components/mobile/page-screen.tsx` (from A1), `components/docs/pages-panel.tsx`, `components/docs/page-parts.tsx` (new), `components/docs/page-hero.tsx` (new), `components/docs/page-labels.tsx`, `components/docs/page-editor.tsx`, `components/docs/page-editor.css`, `components/docs/page-editor-state.ts` (new).
- **Work:**
  - Move `OpenPage`, `Breadcrumb`, `Presence`, `PageFooter`, `useWordCount`, `LoadingBody` and `PanelMessage` into `components/docs/page-parts.tsx`. `PagesPanel` stays the desktop composition.
  - `MobilePageScreen`: a Nav Bar shape (back, title 15.5/800 with "channel · guild", presence avatars, More), `PageHero` (a 116 cover from the guild tint or a hash of the page id, and a 62 icon tile, with no stored data), breadcrumb and labels with a 20 px gutter, the editor, the foot 34 "Saved · end-to-end encrypted" and the word count, and the floating "Chat" pill with the raw unread count of the channel.
  - `components/docs/page-editor.tsx`: a `variant` prop. Touch: no block handle, no selection toolbar, placeholder "Tap to write, / for blocks". `components/docs/page-editor.css`: the `[data-variant=touch]` block (padding 0 20px 120px, h1 26, h2 19, base 15, task boxes as the 18 checkbox).
  - A tap on a to-do box toggles it without raising the keyboard.
  - `components/docs/page-editor-state.ts`: a small store with the editor focus (from `focusin` and `focusout` on the editor). While the editor has focus, the page bar shows Done (accent tint, 64 × 36) in place of More. Done blurs the editor.
  - Back and the pill call `navigate({ kind: 'channel' })`. Hide Comments.
- **Native hooks:** none.
- **Check:** Preview, open "RFC: pages channels": the page fills the screen, no tab strip. Tap a to-do: it toggles and no keyboard. The pill shows "3 new" after new messages, and the chat behind does not mark them read. Desktop C1 unchanged.
- **Depends on:** F1.

#### F3a · Page editing toolbar and slash menu

- **Screens:** M39 (editing a page), M40 (insert a block).
- **Owns:** `components/docs/page-editor.tsx` (from F2), `components/docs/page-editor.css` (from F2), `components/docs/page-picker.tsx`, `components/mobile/keyboard-toolbar.tsx` (new), `components/docs/turn-into-sheet.tsx` (new).
- **Work:**
  - An editor API through `onReady(api)`: run a command, undo and redo (`yUndo`, `yRedo`), insert "/", blur, and focus and block-type signals. A small plugin that marks the current block (`hm-current-block`).
  - `PageKeyboardToolbar` (46), mounted by the touch editor through a portal at the visual viewport bottom while the editor has focus. Tools: "+" (inserts "/"), turn into (sheet), to-do, bullet list, numbered list, indent, undo, then hide keyboard. Every button uses `onPointerDown` with `preventDefault`, plus `onClick` and an `aria-label`. Mention is the page picker as a sheet. Comment is hidden.
  - The editor focus goes to `components/docs/page-editor-state.ts` (F2), so the page bar shows Done. The pill and foot hide while the keyboard is open.
  - Slash menu (touch): two groups, "Basic blocks" (text, heading, task list, bullets, numbers, quote, code, divider) and "In Hachiman" (New sub-page, Link to page). Width = viewport minus 24, max height = the room above the toolbar. A CSS skin with 46 rows and section labels. No per-item hints (Crepe items have only label and icon).
  - `components/docs/page-picker.tsx`: a bottom sheet with search on touch.
- **Native hooks:** P4 hides the accessory bar. `haptic('light')` on insert (optional).
- **Check:** Simulator: tap a block: the toolbar rides on the keyboard with no accessory bar between. Tap "to-do": the block turns into a to-do and the keyboard stays. Type "/": the menu fits above the toolbar.
- **Depends on:** F2, P4.

#### F3b · Page actions sheet

- **Screens:** M41 (page actions sheet).
- **Owns:** `components/mobile/page-screen.tsx` (from F2), `components/docs/page-actions.tsx` (new), `components/docs/page-links.ts`, `components/docs/page-links.test.ts`.
- **Work:** `PageActionsSheet` from More: quick tiles Pin to tabs (lit when pinned), Copy link, Invite (with CREATE_INSTANT_INVITE). Rows: Move to… (same channel only), Export (copy markdown, then the share sheet when it can carry text), Delete page (confirm with the subtree count, permanent wording, then back to the chat). The copy-link builder moves into `components/docs/page-links.ts` with a test. Hide history, comments, duplicate, lock, cross-channel move, PDF and trash.
- **Native hooks:** `haptic('success')` on pin and copy, `haptic('warning')` when the delete confirm opens. `share` needs an http(s) `url` today, and a page link is not one, so Export shares nothing until the seam takes text alone (section 5). Copy markdown works.
- **Check:** Preview: ⋯ opens the sheet. Pin lights the tile and adds the tab. Delete returns to the chat and the bar names the next page.
- **Depends on:** F2. It runs in parallel with the editor toolbar package.

### 4.10 Row G · Guilds and channels

#### G1 · Guild menu sheet

- **Screens:** M43 (guild menu).
- **Owns:** `components/shell/guild-header.tsx`, `components/shell/guild-menu-items.tsx`, `lib/notify.ts`, `components/notify/notify-menu.tsx` (from A2).
- **Work:** the header `DropdownMenu` becomes a `MenuSheet` through P6. While open, the sheet portal draws an `aria-hidden` lifted copy of the header row (38, r8, `surface-raised`, shadow) at the measured rect. A tap on it closes. Close the sheet on resize. Item hints: "Notification settings" shows the level label through a new `notifyLevelLabel()`. One label set for `NOTIFY_LEVELS` on both layouts. Keep one destructive item (owner Delete, else Leave). The header stays 36 tall on mobile.
- **Native hooks:** none for a tap.
- **Check:** Preview: tap the guild name in the drawer: the sheet with three groups, the lifted header above the darker scrim. Desktop dropdown unchanged and with no hint text.
- **Depends on:** P6, A1.

#### G2a · Add a guild and join with invite

- **Screens:** M44 (add a guild), M45 (join with invite).
- **Owns:** `components/add-server-dialog.tsx`, `components/join-server-modal.tsx`, `components/chat/message-tokens.tsx`, `stores/dialogStore.ts` (from E1), `components/shell/tile-row.tsx` (from A5), `components/shell/sidebar-rows.tsx` (from I1).
- **Work:**
  - M44: no footer Cancel on mobile. The E2EE note in the body. Choice cards tinted at rest (no hover on touch), tile 44, chevron in the feature colour. The create and join steps in the same sheet, Back as a quiet 48. Inputs as `MobileField`, no `autoFocus`. A Paste button on the join field.
  - `components/shell/tile-row.tsx` `addLit` and `components/shell/sidebar-rows.tsx` pass `useDialogStore((s) => s.dialog?.kind === 'addGuild')`.
  - M45: extract `InviteCard` (banner placeholder, icon 64 overlap, name 20, member count). The E2EE line names the guild and the count of own active devices. Stacked actions, quiet "Not now" above "Accept invite". `stores/dialogStore.ts`: `joinInvite.from?: { userId, channelId }` for "From marlowe, in your DMs".
  - `components/chat/message-tokens.tsx`: an invite link opens the join sheet in-app (stash the key, `openDialog`) instead of a browser tab.
- **Native hooks:** clipboard read for Paste.
- **Check:** Preview: tap "+" beside GUILDS: the sheet, and the "+" stays lit under the dim. Tap an invite link in a DM: the join sheet with "From marlowe, in your DMs".
- **Depends on:** P6, I1, E1.
- **As built (W4):**
  - `OVER_LEFT_DRAWER` in `stores/dialogStore.ts` lists the dialogs that a left-drawer control opens (`addGuild`). The drawer close rule keeps the left drawer open under them (`lib/mobile-drawer.ts`, `{ kind: 'dialog', overLeft }`), so the "+" stays lit under the dim.
  - The preview fixture has a marlowe message in DM1 with an invite link on this server, and `previewInvite` expires in 6 days.

#### G2b · Invite, create channel, leave and delete

- **Screens:** M46 (invite people), M47 (create channel), M50 (leave guild), M51 (delete channel).
- **Owns:** `components/invite-dialog.tsx`, `components/create-channel-dialog.tsx`, `components/remove-server-dialog.tsx`, `components/shell/dialogs.tsx` (from E3), `stores/dialogStore.ts` (from G2a), `components/sidebar/channel-row.tsx` (from J2), `components/sidebar/guild-channels.tsx` (from A5), `lib/model.ts`.
- **Work:**
  - M46: no Done on mobile. The two limits as `MobileField` selects. Before creation: "Create link". After: Copy (secondary 80 × 38) and Share (primary 38) when `platform.share` is not null. The expiry hint spells the date. `stores/dialogStore.ts`: `invite.channelId?`. The row's invite icon is lit while its sheet is open. The "Lands in" subtitle is not possible (section 5): use the guild name.
  - M47: no Cancel. Submit is a full-width 48 inside the form. Checked type card tinted. The name field with the type icon in the feature colour, no `autoFocus`. The category "+" is lit while open. Hide the private toggle and the lowercase helper (section 5).
  - M50 and M51: centred `ConfirmDialog` (P6). `components/remove-server-dialog.tsx`: icon 40, name 15.5, the owner's type-the-name field as `MobileField`. `DeleteChannelDialog` in `components/shell/dialogs.tsx`: a subtitle "Text channel · Night Owls", "with its whole message history", `OctagonAlert`. The row is marked red while the dialog is open.
- **Native hooks:** `share` (exists). The `#k=` seed in a link with history is allowed in the share payload (contract §12.17). Native code must not log it.
- **Check:** Simulator: Invite people → Create link → Share opens the iOS share sheet. Delete a channel: centred dialog, the row is red under the dim. Leave a guild: the drawer shows the next guild.
- **Depends on:** P6, G2a, E3, J2.

#### G3 · Channel settings and permissions

- **Screens:** M48 (channel settings), M49 (channel permissions).
- **Owns:** `components/settings/channel-overview.tsx`, `components/settings/channel-permissions.tsx`, `components/mobile/chip-scroller.tsx` (new).
- **Work:**
  - M48: OVERVIEW label, the name as `MobileField` with the hash lead, the topic textarea (min 96, counter at the bottom left), a live preview that renders `MobileChannelHeader` inert with the draft name and topic. `SaveBar layout="foot"`.
  - M49: one column. Targets as a `ChipScroller` (radiogroup, 38 chips, selected scrolls into view). "Add role or member" as the Nav Bar "+" through `NavAction`, opening a sheet. A 36 trash button to remove an override. The tri-state as `SegmentedControl size="touch"`. `SaveBar layout="foot"`.
- **Native hooks:** none.
- **Check:** Preview: channel gear → M48 pushes. Type in the topic: the preview updates and the foot shows unsaved changes. Permissions → tap deny on a rule: the "Denied here" chip shows. Save signs the change.
- **Depends on:** E1, A2.
- **As built (W3):**
  - The topic counter is at the bottom right, as M48 draws it (not the bottom left).
  - The Save foot of M48 and M49 docks under the screen panel through `DockedFoot` (in `components/mobile/foot.tsx` since W4), not sticky inside the form. It portals the foot as the last child of the enclosing `PushedScreen`. `PushedScreen` then drops the safe-bottom padding of its body. H1 and H2 can use `DockedFoot` for pages with rows after the form.
  - `ChipScroller({ label, options: {value,label,lead?,count?}[], value, onValueChange, className })` in `components/mobile/chip-scroller.tsx` reuses `FilterChip` at 38 and shows the selected chip with `revealScrollLeft`.
  - The three-way switch is `SegmentedControl size="touch"`: 44 high with 36-wide segments. The mock draws 40 high with 40-wide segments.

### 4.11 Row H · Guild settings

All four screens sit in E1's tab frame. Each page file branches on the layout. Emoji, Soundboard and Bans keep their desktop pages inside the frame.

#### H1 · Guild overview

- **Screens:** M52 (overview).
- **Owns:** `components/settings/guild-overview.tsx`, `components/settings/guild-overview-mobile.tsx` (new), `components/region-select.tsx`.
- **Work:** extract `useGuildOverviewForm(guild)`. `GuildOverviewMobile`: banner 104 and an overlapping 72 icon, each with a "Change" button (two `useImageUpload` instances), a tap on a set image opens a sheet with Choose image and Remove. Fields: name, voice region, earlier messages, welcome channel. `components/region-select.tsx` passes `className`. `SaveBar layout="foot"`, `haptic('success')` on save. Keep the desktop hint copy ("Shown above the channel list…"), not the mock's "show on invites".
- **Native hooks:** file input picker (P4 plist), `haptic('success')`.
- **Check:** Simulator: Change icon opens the photo picker. Save shows "Changes saved." Delete guild row opens the remove sheet.
- **Depends on:** E1, E2.
- **As built (W4):**
  - `useGuildOverviewForm(guild)` and the pure `guildOverviewPatch(guild, draft)` (tested in `components/settings/guild-overview.test.ts`) live in `components/settings/guild-overview.tsx`. `GuildOverviewPage` calls the hook and gives the form to `GuildOverviewMobile`, so a layout switch keeps the draft.
  - The Save foot docks under the panel through `DockedFoot`, so the tab frame's Delete guild row sits between the fields and the foot, as M52 draws it.
  - The Change buttons read "Add icon" / "Add banner" when no image is set. A tap on an empty image opens the picker.
  - The welcome channel field (not in the mock) is the fourth field, with a DoorOpen lead. The name field has a Tag lead in place of the mock's sample moon.
  - `RegionSelect` passes its other props (`className`, `size`, `lead`, `disabled`, an optional `id`) to `NativeSelect`.

#### H2 · Roles

- **Screens:** M53 (roles).
- **Owns:** `components/guild-settings-roles.tsx`, `components/settings/guild-roles-mobile.tsx` (new), `components/settings/use-role-list.ts` (new), `components/settings/hoist-row.tsx`, `components/ui/permission-row.tsx`.
- **Work:** extract `useRoleList`, `useRoleDraft`, `ColourSwatches` and `PermissionList` (with `size`). Mobile: a pinned `RoleStrip` (36 chips with dot and count, Lock above the ceiling), the editor (name field with a colour lead, swatches with 36 hit areas including No colour and Custom, hoist row, PERMISSIONS with all 20 rows and the VIA ADMINISTRATOR state, Delete role as a danger row), a foot Save only while dirty. "+ Create role" through `NavAction`. A chip hold opens Move higher, Move lower and Delete. Keep the stored `SWATCHES` values.
- **Native hooks:** `haptic('light')` on a chip hold, `haptic('success')` on save. Custom colour is an `<input type="color">`, which WebKit shows as the iOS colour picker (no bridge op).
- **Check:** Preview: "+" creates and selects "new role". Hold a chip: Move higher works with the ceiling rules. Administrator on: rows below dim and stay disabled.
- **Depends on:** E1.
- **As built (W4):**
  - No colour and Custom are 36 chips on a second row under the eight swatches: ten 36 hit areas need 360 px, and the iPhone SE body is 343.
  - The hoist hint reads "Online members with this role appear under <NAME> in the member list." (only online members are grouped).
  - The Save foot is `DockedFoot` + `SaveBar layout="foot"`, shown only while dirty or saving.
  - The hold menu (Move higher, Move lower, Delete role) is on editable roles only. An sr-only "Actions for <role>" button opens it for VoiceOver.
  - `PermissionList` lives in `components/ui/permission-row.tsx` and takes the items as a prop. `ColourSwatches` stays desktop-only; the mobile swatches are `SwatchPicker` in `components/settings/guild-roles-mobile.tsx`. Both use `SWATCHES` from `components/settings/use-role-list.ts`, so the two page files do not import each other.

#### H3 · Members

- **Screens:** M54 (members).
- **Owns:** `components/guild-settings-members.tsx`, `components/settings/guild-members-mobile.tsx` (new).
- **Work:** extract `useMemberGates` and `useMemberEdit`. Search (`type="search"`, 44, 16 px). "n MEMBERS · n ONLINE". Rows 62 (avatar 36, role-ink name, mono handle when a nick exists, YOU tag, crown, role chips `size="sm"` or "No role", Kick 36 where allowed). A tap or hold opens `MemberEditSheet` in `components/settings/guild-members-mobile.tsx` (nickname, role checklist, Kick). It is not A4's chat `MemberSheet`. Kick confirm as a centred dialog. Desktop gets `aria-label={`Kick ${name}`}`. Rows use `content-visibility: auto`.
- **Native hooks:** `haptic('light')` on hold, `haptic('warning')` when the kick confirm opens.
- **Check:** Preview: search filters live. Kick shows only on others who are not the owner. A role toggle in the sheet saves as a signed admin action.
- **Depends on:** E1.
- **As built (W4):**
  - The pure gates and helpers are in `components/settings/member-gates.ts` (with `member-gates.test.ts`). The hooks `useMemberGates` and `useMemberEdit` are in `components/settings/use-member-gates.ts`.
  - The member edit sheet stays open under the kick confirm. A successful kick closes both.

#### H4 · Invites

- **Screens:** M55 (invites).
- **Owns:** `components/guild-settings-invites.tsx`, `components/settings/guild-invites-mobile.tsx` (new), `components/settings/use-guild-invites.ts` (new), `components/settings/invites.ts`, `components/settings/invites.test.ts`, `components/settings/invite-options.tsx`, `services/InviteService.ts`, `components/settings/settings-model.tsx` (from E3).
- **Work:** extract `useGuildInvites` with a small module cache keyed by guild id (only with MANAGE_GUILD), so the tab count reads it. `isUsedUp` and `inviteExpiryState` in `components/settings/invites.ts` with tests. Mobile list: code box, History and Permanent chips, Copy (hidden for history invites), Delete (always enabled, with a confirm on touch), the meta line with the gold "soon" state. `InviteCreateBar` docked on `surface-panel`: two 52 select boxes (`components/settings/invite-options.tsx` `layout="boxes"`), Include history for admins, "Create and copy link". `services/InviteService.ts`: start the copy inside the tap with `ClipboardItem` and a promise. If the copy fails for an invite with history, show the link once in a sheet with Copy and Share.
- **Native hooks:** `haptic('success')` on copy.
- **Check:** Simulator: Create and copy link → paste in Notes works. Invites tab count matches the active invites. Desktop invites table unchanged.
- **Depends on:** E1, E3.
- **As built (W5):**
  - The invite list cache (`loadGuildInvites`, `guildInviteList`, `subscribeGuildInviteLists`, `addGuildInvite`, `revokeGuildInvite`) is in `services/InviteService.ts`, so `resetInvites()` clears it at sign-out. The hooks `useGuildInvites`, `useActiveInviteCount`, `useInviteCreateForm` and `useInvitePermissions` are in `components/settings/use-guild-invites.ts`.
  - The tab count shows on mobile only.
  - `copyLinkFromTap` starts the clipboard write inside the tap. It falls back to `writeText` when `ClipboardItem` is missing or takes no promise.
  - Delete stays fully opaque on used-up rows (always enabled). The mock dims it.
  - Create and copy errors show inside the docked create bar. On a short screen the bar is capped at 60 % of `--app-height` and scrolls inside.

### 4.12 Row I · DMs and safety

#### I1 · DM list and DM home

- **Screens:** M8 (sidebar in DMs), M56 (DM home).
- **Owns:** `components/sidebar/dm-space.tsx`, `components/home-pane.tsx`, `components/people/active-now.tsx`, `components/voice/live-card.tsx`, `components/ui/presence.tsx`, `components/shell/user-avatar.tsx`, `components/shell/sidebar-rows.tsx` (from A5), `lib/time-format.ts`, `lib/time-format.test.ts`, `components/mobile/dm-home-screen.tsx` (new).
- **Work:**
  - `DmList`: newest first with `recentDms(dms, lastAt)` (also on desktop, as the captions ask). Variants `sidebar`, `drawer` (48, avatar 30) and `home` (58, avatar 40, a meta column with time and count badge or LIVE). "Streaming <channel>" in purple for a live 1:1. A 3-face stack for a group DM (`GroupAvatars` exported with a size). A cutout that matches the drawer tint, not `surface-window`. On mobile, "Conversations" is a category row with "+".
  - `components/home-pane.tsx`: on mobile it renders `MobileDmHome` (header with "n online · n conversations" and New Message, the search field that calls `openSwitcher('open')` (J3 starts M66 on the People chip when it opens over the DM home), the People row, ACTIVE NOW, CONVERSATIONS). The People list is a pushed screen behind the People row, with a hold menu instead of the hover More button.
  - `components/people/active-now.tsx`: `ActiveNowStrip` (212 × 112 cards, scroll snap, the whole card opens the channel, hidden when there are no calls). `components/voice/live-card.tsx`: a `strip` frame with the avatar on the live tint. Never a frame of the stream.
  - `components/ui/presence.tsx` and `components/shell/user-avatar.tsx`: the dot scales with the avatar (11 on 32, 13 on 40, 24 on 72) and an optional `live` dot (`--status-live`).
  - `lib/time-format.ts`: `formatListTime` ("HH:mm", weekday, "d MMM") with tests.
- **Native hooks:** `haptic('light')` on row holds.
- **Check:** Preview, open the DM space: rows newest first with times and counts. Swipe the Active Now strip. Desktop sidebar DM list is now sorted the same way.
- **Depends on:** A1, A5, P6.

#### I2 · DM header, intro and trust

- **Screens:** M7 (DM marlowe), M57 (DM yuki.h, verified).
- **Owns:** `components/mobile/mobile-channel-header.tsx` (from A2), `components/people/trust-chip.tsx`, `components/people/trust-look.ts`, `components/people/trust-look.test.ts`, `components/people/dm-profile-column.tsx`, `components/people/use-mutual-guilds.ts` (new), `components/chat/channel-intro.tsx`, `components/chat/key-card.tsx` (new), `pkgs/hachiman-crypto/src/bridge/stub.ts`.
- **Work:**
  - DM header: avatar 32, name 17/800 over the voice activity line 12.5/700, then a new `TrustButton` in `components/people/trust-chip.tsx` (36, icon only, state and date in the label), `DmCallButton`, a profile button that opens the right drawer (hidden for group DMs). Poke, Pins and Notify move into the profile drawer as a row of 36 buttons.
  - `components/people/trust-look.ts`: `lookFor(trust, keyChange)` (a notice-severity change looks gold "Not verified", a blocking one red) and `securityText()`, shared by the drawer and the intro. Update the tests. Desktop `TrustChip` uses `lookFor` too (the E6 caption asks for it).
  - `DmIntro`: avatar 72, title 28/800, mutual guild chips (h 30, at most 3 plus "+n", from `components/people/use-mutual-guilds.ts`), a trust chip per state, and `KeyCard` when verified ("Verified 2 Oct" from `verifiedAt`, the explainer, no fingerprint yet).
  - `components/people/dm-profile-column.tsx`: fills the 320 drawer (`className`). It mounts on the first drawer open only.
  - `pkgs/hachiman-crypto/src/bridge/stub.ts`: per-user trust fixtures for `?preview` (verified for yuki.h, tofu for marlowe).
- **Native hooks:** `haptic('success')` after verification (B1 fires it).
- **Check:** Preview: marlowe's DM shows the gold shield, yuki.h's shows the green one and the key card. Profile button opens the drawer. Long names truncate cleanly at 393.
- **Depends on:** A2, B1.

#### I3 · Key change dialog and notice line

- **Screens:** M58 (key changed, blocking), M59 (key changed, notice).
- **Owns:** `components/security/key-change-dialog.tsx`, `stores/cryptoStore.ts`, `stores/cryptoStore.test.ts`, `components/security/security-notices.tsx`, `components/chat/composer.tsx` (from A6), `components/chat/chat-body.tsx` (from A2), `components/chat/key-change-line.tsx` (new), `components/chat/format.ts`, `components/chat/format.test.ts`, `components/chat/transcript.tsx` (from A3), `pkgs/hachiman-crypto/src/bridge/stub.ts` (from I2).
- **Work:**
  - M58: a centred `alertdialog` (P6 `presentation="dialog"`). Footer buttons 48 with icons, Compare on top. A Close button for the blocking case that defers: `cryptoStore` gets `deferredKeyChanges` and `deferKeyChange(userId)` (status only, no key material). `components/security/security-notices.tsx` skips deferred users when it reopens. The composer gets a paused look on mobile (PAUSED chip, dimmed tools, "Sending is paused", a tap reopens the dialog through `onPausedTap` from `components/chat/chat-body.tsx`). Blur the composer and make the chat `inert` while open. Hide the key compare box until fingerprints exist.
  - M59: `KeyChangeLine` (gold card with Compare) placed by `keyChangeSlot()` in `components/chat/format.ts` (with tests) for a 1:1 DM with a non-blocking change. On mobile `components/security/security-notices.tsx` does not push the corner toast for a notice change. The corner stack moves under the tab strip on mobile.
  - `pkgs/hachiman-crypto/src/bridge/stub.ts`: a pushed key change for `?preview`.
- **Native hooks:** `haptic('warning')` when the blocking dialog opens.
- **Check:** Preview: trigger a blocking change: the dialog cannot be dismissed by the scrim or a swipe. Close defers and the composer shows PAUSED. Tap the field: the dialog returns. A notice change shows the gold line and no dialog.
- **Depends on:** I2, A6, P6.

### 4.13 Row J · Channel states, voice and search

M65 is in B2.

#### J1 · Channel states

- **Screens:** M60 (#lfg not pinned), M61 (#clips empty), M62 (#patch-notes read only), M63 (#deploys restricted).
- **Owns:** `components/chat/channel-intro.tsx` (from F1), `components/notify/notify-menu.tsx` (from G1), `components/chat/composer.tsx` (from I3), `components/chat/chat-body.tsx` (from I3), `components/mobile/mobile-channel-header.tsx` (from I2).
- **Work:**
  - Mobile channel start: tile 60 (icon 28), title 26/800, topic 15, actions 44 ("Pin to tabs" in the accent tint when not pinned, "Invite", "Edit"). Pin to tabs calls `haptic('light')`, and the new tab lights and scrolls into view.
  - M61 `DropCard`: the tile and text above two 48 buttons, Upload (primary) and "Paste a link" (secondary). The body is the topic when set. "Paste a link" calls `focusComposer()` (A2) inside the tap. A store request that an effect reads would focus outside the gesture, and the keyboard would not rise. No `clipboard.readText()`.
  - M62: the read-only notice at 60 with a 44 Follow button (two states: Bell + "Follow", gold BellRing + "Following"), a shorter mobile copy, `haptic('light')` on toggle. Hide Threads when a chip sits in the title row.
  - M63: `RestrictedCard` full width with a 46 "Manage access" row at the foot (pushes M49). The restricted chip shows two role names and "+n".
- **Native hooks:** `haptic('light')`, the file picker.
- **Check:** Preview: `#lfg` (unpinned) → Pin to tabs adds and lights the tab. `#clips` empty → Upload opens the picker. `#patch-notes` → Follow toggles. `#deploys` → Manage access pushes the permissions screen.
- **Depends on:** I3, G1, F1.
- **As built (W5):**
  - The pure helpers `cantPostReason`, `chipRoles` and `hasTitleChip` are in `components/chat/channel-states.ts` (with a test).
  - Where the header leaves Threads out for a title chip, the channel sheet (`components/mobile/channel-info-sheet.tsx`) has a Threads row that opens the same list (`ThreadsSheet` in `components/threads/threads-button.tsx`). Pin to tabs in that sheet also calls `haptic('light')`.

#### J2 · Voice channel not joined

- **Screens:** M64 (Ranked queue, not joined).
- **Owns:** `components/voice/voice-room.tsx` (from B2), `components/voice/live-card.tsx` (from I1), `components/voice/voice-occupant-row.tsx` (new), `components/sidebar/channel-row.tsx` (from A5).
- **Work:** extract `VoiceMemberRow` from `components/sidebar/channel-row.tsx` into `VoiceOccupantRow` with sizes 26 (sidebar, unchanged) and 56 (mobile: avatar 32 with presence, role-ink name, a detail line such as "Sharing screen · muted", mute and LIVE marks). `NotJoinedMobile`: a full-width `LiveCard size="lg"` with the bottom scrim, a `WatchersLine` (others in the call), "IN RANKED QUEUE · n" with occupant rows, then the join block at the foot: title 20/800, "n in call · region", Join voice (voice green 48), Watch stream (secondary 48), the move note.
- **Native hooks:** mic permission and `apps/hachiman-ios/Hachiman/AudioSession.swift` on join.
- **Check:** Preview: Ranked queue while in Lounge: the stream card without a frame, quill's row, Join voice moves the call. Watch stream joins muted.
- **Depends on:** B2, I1, A5.

#### J3 · Full-screen search

- **Screens:** M66 (search).
- **Owns:** `components/shell/quick-switcher.tsx`, `components/shell/switcher-state.ts`, `lib/quick-switcher.ts`, `lib/quick-switcher.test.ts`, `components/mobile/search-screen.tsx` (new).
- **Work:** extract `useSwitcherResults(query, filter)`. `components/shell/switcher-state.ts` keeps the filter beside the mode. On mobile, when the screen opens over the DM home (I1), the chips start on People. Add `matchRange(name, query)` (new) next to `matchTier` in `lib/quick-switcher.ts`, with tests. `MobileSearchScreen` at `fixed inset-0` with safe areas: search field 44 (16 px, `type="search"`, `enterKeyHint="search"`, no autocorrect), Cancel, `FilterChips` (All, People, Channels, "In: any guild"), grouped results (RECENT from nav history, CHANNELS, PEOPLE) with the match highlight from `matchRange()`. Rows 52 with tiles or avatars, the live tag, "n in call", and a 36 Message button on people. Hold a result to pin it. Hide the `SwitcherField` keycap on mobile. Focus the input inside the opening tap. Hide Messages, From and RECENT queries (section 5).
- **Native hooks:** `haptic('light')` on hold to pin.
- **Check:** Simulator: tap "Search or jump to" in the drawer: the drawer closes, the screen opens with the keyboard up. Type "qu": matches highlight. The Search key opens the first result.
- **Depends on:** A1, P2.

#### J4 · Inbox screen

- **Screens:** M67 (inbox).
- **Owns:** `components/inbox/inbox-button.tsx`, `components/inbox/inbox-screen.tsx` (new), `components/inbox/inbox-model.ts`, `components/inbox/inbox-model.test.ts`, `services/UnreadService.ts`.
- **Work:** on mobile the inbox button opens `InboxScreen` as a local pushed overlay. Nav Bar "Inbox" with "n unread · all guilds" and "Mark all read". Chips: All, Mentions, Channels (the desktop "Unread" tab, the honest port). Items: avatar 36 with an 18 kind badge, head, context line, the message with existing tokens (an undecrypted row shows its placeholder). `components/inbox/inbox-model.ts`: a `kind` per entry and `inboxCounts()` with tests. `services/UnreadService.ts`: `markAllRead()` loops `markChannelRead` per visible badge. A tap jumps to the message and pops.
- **Native hooks:** `haptic('success')` on Mark all read.
- **Check:** Preview: the inbox lists the mentions. Mark all read clears the sidebar dot. Desktop popover unchanged.
- **Depends on:** A1, P2.

### 4.14 Screen coverage

| Screen | Package | Screen | Package | Screen | Package |
|---|---|---|---|---|---|
| M1 | A2 | M24 | D1 | M47 | G2b |
| M2 | A1 | M25 | D2 | M48 | G3 |
| M3 | A5 | M26 | D2 | M49 | G3 |
| M4 | A4 | M27 | D3 | M50 | G2b |
| M5 | A3 | M28 | D3 | M51 | G2b |
| M6 | A6 | M29 | E1 | M52 | H1 |
| M7 | I2 | M30 | E2 | M53 | H2 |
| M8 | I1 | M31 | E2 | M54 | H3 |
| M9 | B1 | M32 | E4 | M55 | H4 |
| M10 | B2 | M33 | E3 | M56 | I1 |
| M11 | A2 | M34 | E3 | M57 | I2 |
| M12 | A5 | M35 | E3 | M58 | I3 |
| M13 | C1 | M36 | A5 | M59 | I3 |
| M14 | C1 | M37 | F1 | M60 | J1 |
| M15 | C1 | M38 | F2 | M61 | J1 |
| M16 | C2 | M39 | F3a | M62 | J1 |
| M17 | C2 | M40 | F3a | M63 | J1 |
| M18 | C3 | M41 | F3b | M64 | J2 |
| M19 | C3 | M42 | F1 | M65 | B2 |
| M20 | C3 | M43 | G1 | M66 | J3 |
| M21 | C2 | M44 | G2a | M67 | J4 |
| M22 | D1 | M45 | G2a | | |
| M23 | D1 | M46 | G2b | | |

### 4.15 Rule and behaviour coverage

| Rule or behaviour spec (`X9zRx`) | Packages |
|---|---|
| Rule 01 Chat is the screen | A1 (frame, tab strip in the tinted window), A2 (header, footer) |
| Rule 02 Same sidebar, as a drawer | A1 |
| Rule 03 Members from the right | A1 (drawer), A4 (members), F1 (pages) |
| Rule 04 Voice stays in reach | A2 (voice bar), A1 (dock in the drawer foot) |
| Rule 05 Pages open on their chat | A5 (row tap), F1 (page bar), F2 (pill back). "Posts its edits back into the chat" is not built (section 5 "Page activity in chat", question 6.1.2) |
| Rule 06 Settings push, choices rise | P2, P6, E1, D2, H1 to H4 |
| Open sidebar | A1 |
| Close sidebar | A1 (scrim, drag, close button. The chat card stays mounted, section 2.3) |
| Members | A1, A4 |
| Pinned tabs | A1 (scroll, scroll into view), A5 (hold to reorder or unpin) |
| Message actions | P2 (`useLongPress`), A3 (lift, sheet, tap outside closes) |
| Keyboard | P1 (`--kb`), P4 (no accessory bar), A2 (voice bar hides), A6 (composer, `@` popover) |
| Voice | A2 |
| Sizes | P1, A1, A2, A6 |
| Touch | P3, A5, I1, B2 (section 2.10) |
| Pages | A5, F1, F2, F3a (`/` menu). "Edits post one line into the chat": not built, as rule 05 |
| Pushed screens | P2, E1, D2, H1 to H4 |
| Sheets and dialogs | P6 (drawn scrim 72 %, section 2.1), A3, G2b, I3 (red last, name in bold) |
| Sign-in | C1 (system sheet), C2 and C3 (link, restore, start new, reset) |

### 4.16 Work-package index

The machine-readable form of sections 4.2 to 4.13. Paths follow the path rule at the top. `new` marks a file that the package creates. `from` names the package that owned the file in an earlier wave. If this block and a package section disagree, the package section wins. Fix both in the same change.

```json
{"packages": [
  {"id": "P1", "title": "Layout switch, tokens, viewport and appearance", "wave": "W0", "screens": [], "dependsOn": [], "nativeHooks": ["setAppearance"], "owns": [{"path": "hooks/use-layout.ts", "new": true}, {"path": "hooks/use-visual-viewport.ts", "new": true}, {"path": "hooks/use-native-appearance.ts", "new": true}, {"path": "lib/css-color.ts", "new": true}, {"path": "assets/main.css"}, {"path": "App.tsx"}, {"path": "components/ui/tooltip.tsx"}]},
  {"id": "P2", "title": "Mobile kit", "wave": "W0", "screens": [], "dependsOn": [], "nativeHooks": [], "owns": [{"path": "components/mobile/sheet.tsx", "new": true}, {"path": "components/mobile/nav-bar.tsx", "new": true}, {"path": "components/mobile/pushed-screen.tsx", "new": true}, {"path": "components/mobile/list.tsx", "new": true}, {"path": "components/mobile/foot.tsx", "new": true}, {"path": "components/mobile/filter-chips.tsx", "new": true}, {"path": "hooks/use-long-press.ts", "new": true}, {"path": "lib/long-press.ts", "new": true}, {"path": "lib/long-press.test.ts", "new": true}]},
  {"id": "P3", "title": "Touch sizes of the ui primitives", "wave": "W0", "screens": [], "dependsOn": [], "nativeHooks": [], "owns": [{"path": "components/ui/button.tsx"}, {"path": "components/ui/icon-button.tsx"}, {"path": "components/ui/switch.tsx"}, {"path": "components/ui/segmented-control.tsx"}, {"path": "components/ui/radio-card.tsx"}, {"path": "components/ui/checkbox.tsx"}, {"path": "components/ui/callout.tsx"}, {"path": "components/ui/input.tsx"}, {"path": "components/ui/native-select.tsx"}, {"path": "components/ui/textarea.tsx"}, {"path": "components/ui/role-chip.tsx"}, {"path": "components/ui/field.tsx"}, {"path": "components/ui/chip.tsx", "new": true}, {"path": "components/mobile/field.tsx", "new": true}]},
  {"id": "P4", "title": "iOS host native changes", "wave": "W0", "screens": [], "dependsOn": [], "nativeHooks": [], "owns": [{"path": "apps/hachiman-ios/index.html"}, {"path": "apps/hachiman-ios/Hachiman/WebView.swift"}, {"path": "apps/hachiman-ios/Hachiman/Info.plist"}, {"path": "apps/hachiman-ios/src/probe.ts"}]},
  {"id": "P5", "title": "saveTextFile seam", "wave": "W0", "screens": [], "dependsOn": [], "nativeHooks": [], "owns": [{"path": "shared/IPlatformService.ts"}, {"path": "apps/hachiman-browser/src/platforms/browser/PlatformService.ts"}, {"path": "apps/hachiman-electron/src/renderer/src/PlatformService.ts"}, {"path": "apps/hachiman-ios/src/platforms/ios/PlatformService.ts"}, {"path": "apps/hachiman-ios/Hachiman/Bridge.swift"}, {"path": "apps/hachiman-ios/Hachiman/Native.swift"}, {"path": "docs/gateway-protocol.md"}]},
  {"id": "P6", "title": "Dialogs, menus and popovers as sheets", "wave": "W1", "screens": [], "dependsOn": ["P1", "P2", "P3"], "nativeHooks": [], "owns": [{"path": "components/ui/dialog.tsx"}, {"path": "components/ui/modal-window.tsx"}, {"path": "components/ui/confirm-dialog.tsx"}, {"path": "components/ui/dropdown-menu.tsx"}, {"path": "components/ui/context-menu.tsx"}, {"path": "components/ui/popover.tsx"}, {"path": "components/mobile/menu-sheet.tsx", "new": true}, {"path": "components/chat/attachments/lightbox.tsx"}]},
  {"id": "A1", "title": "Mobile shell, drawers and tab strip", "wave": "W1", "screens": ["M2"], "dependsOn": ["P1", "P2"], "nativeHooks": ["setAppearance"], "owns": [{"path": "components/mobile/mobile-shell.tsx", "new": true}, {"path": "components/mobile/drawer.tsx", "new": true}, {"path": "components/mobile/drawer-state.ts", "new": true}, {"path": "components/mobile/use-swipe.ts", "new": true}, {"path": "components/mobile/mobile-tab-strip.tsx", "new": true}, {"path": "components/mobile/mobile-chat-pane.tsx", "new": true}, {"path": "components/mobile/settings-host.tsx", "new": true}, {"path": "components/mobile/page-screen.tsx", "new": true}, {"path": "lib/swipe.ts", "new": true}, {"path": "lib/swipe.test.ts", "new": true}, {"path": "lib/mobile-drawer.ts", "new": true}, {"path": "lib/mobile-drawer.test.ts", "new": true}, {"path": "App.tsx", "from": "P1"}, {"path": "hooks/use-app-shortcuts.ts"}, {"path": "components/shell/shell.tsx"}, {"path": "components/shell/sidebar.tsx"}, {"path": "components/shell/tab-bar.tsx"}, {"path": "components/shell/use-guild-tint.ts"}, {"path": "components/people/right-column.tsx"}, {"path": "stores/unreadStore.ts"}]},
  {"id": "A2", "title": "Chat pane: header, voice bar and footer", "wave": "W2", "screens": ["M1", "M11"], "dependsOn": ["A1", "P6"], "nativeHooks": ["haptic"], "owns": [{"path": "components/mobile/mobile-chat-pane.tsx", "from": "A1"}, {"path": "components/mobile/mobile-channel-header.tsx", "new": true}, {"path": "components/mobile/voice-bar.tsx", "new": true}, {"path": "components/mobile/channel-info-sheet.tsx", "new": true}, {"path": "components/mobile/mobile-chat-footer.tsx", "new": true}, {"path": "lib/media-caps.ts", "new": true}, {"path": "components/shell/channel-pane.tsx"}, {"path": "components/chat/chat-body.tsx"}, {"path": "components/chat/typing-line.tsx"}, {"path": "components/voice-connected-panel.tsx"}, {"path": "components/threads/threads-button.tsx"}, {"path": "components/pins/pins-button.tsx"}, {"path": "components/notify/notify-menu.tsx"}]},
  {"id": "A3", "title": "Long press and the message action sheet", "wave": "W2", "screens": ["M5"], "dependsOn": ["A1", "P2", "P6"], "nativeHooks": ["haptic"], "owns": [{"path": "components/chat/message-row.tsx"}, {"path": "components/chat/message-toolbar.tsx"}, {"path": "components/chat/message-more-items.tsx"}, {"path": "components/chat/transcript.tsx"}, {"path": "components/chat/emoji-picker.tsx"}, {"path": "components/chat/message-actions.ts", "new": true}, {"path": "components/mobile/message-action-sheet.tsx", "new": true}, {"path": "components/mobile/quick-reactions.tsx", "new": true}, {"path": "components/chat/reactions.tsx"}]},
  {"id": "A4", "title": "Members drawer and profile sheet", "wave": "W2", "screens": ["M4"], "dependsOn": ["A1", "P6"], "nativeHooks": ["haptic"], "owns": [{"path": "components/member-list.tsx"}, {"path": "components/people/member-moderation.tsx"}, {"path": "components/user-profile-popover.tsx"}, {"path": "components/mobile/member-sheet.tsx", "new": true}]},
  {"id": "A5", "title": "Touch reorder and hold menus in the drawer and strip", "wave": "W2", "screens": ["M3", "M12", "M36"], "dependsOn": ["A1", "P6"], "nativeHooks": ["haptic"], "owns": [{"path": "hooks/use-sortable-row.ts"}, {"path": "components/shell/tab-bar.tsx", "from": "A1"}, {"path": "components/shell/tile-row.tsx"}, {"path": "components/shell/sidebar-rows.tsx"}, {"path": "components/sidebar/channel-row.tsx"}, {"path": "components/sidebar/guild-channels.tsx"}, {"path": "components/sidebar/sidebar-row.ts"}, {"path": "components/events/event-row.tsx"}]},
  {"id": "A6", "title": "Composer and keyboard", "wave": "W3", "screens": ["M6"], "dependsOn": ["A2", "P1"], "nativeHooks": [], "owns": [{"path": "components/chat/composer.tsx"}, {"path": "components/chat/use-composer.ts", "new": true}, {"path": "components/chat/mention-menu.tsx"}, {"path": "components/mobile/mobile-composer.tsx", "new": true}, {"path": "components/mobile/mobile-chat-footer.tsx", "from": "A2"}]},
  {"id": "B1", "title": "Verification sheet", "wave": "W2", "screens": ["M9"], "dependsOn": ["P6", "P3"], "nativeHooks": ["haptic", "scanQr"], "owns": [{"path": "components/security/verification-dialog.tsx"}, {"path": "components/security/qr-view.tsx"}]},
  {"id": "B2", "title": "Voice stage and verify call", "wave": "W3", "screens": ["M10", "M65"], "dependsOn": ["A2", "A4", "B1", "P6"], "nativeHooks": ["haptic"], "owns": [{"path": "components/voice/voice-room.tsx"}, {"path": "components/voice/voice-tile.tsx"}, {"path": "components/voice/voice-tile-styles.ts"}, {"path": "components/voice/voice-header.tsx"}, {"path": "components/voice/screen-share-controls.tsx"}, {"path": "components/voice/dm-call.tsx"}, {"path": "components/voice/verify-call-dialog.tsx"}]},
  {"id": "C1", "title": "Welcome and sign-in", "wave": "W1", "screens": ["M13", "M14", "M15"], "dependsOn": ["P1", "P3"], "nativeHooks": [], "owns": [{"path": "components/sign-in-screen.tsx"}, {"path": "services/TakusenService.ts"}, {"path": "apps/takusen/src/components/ui/input.tsx"}]},
  {"id": "C2", "title": "Set-up gate: choose, link and done", "wave": "W1", "screens": ["M16", "M17", "M21"], "dependsOn": ["P1", "P2", "P3"], "nativeHooks": ["haptic"], "owns": [{"path": "components/security/onboarding.tsx"}, {"path": "components/security/onboarding-steps.ts"}, {"path": "components/security/screen-window.tsx"}, {"path": "components/security/link-new-device.tsx"}, {"path": "components/security/sas-emoji.tsx"}, {"path": "components/security/setup-screens.tsx", "new": true}, {"path": "components/security/setup-done.tsx", "new": true}]},
  {"id": "C3", "title": "Restore, new identity and reset", "wave": "W3", "screens": ["M18", "M19", "M20"], "dependsOn": ["C2", "P5"], "nativeHooks": ["haptic", "saveTextFile"], "owns": [{"path": "components/security/onboarding.tsx", "from": "C2"}, {"path": "components/security/setup-screens.tsx", "from": "C2"}, {"path": "components/security/recovery-key-view.tsx"}]},
  {"id": "D1", "title": "Link a new device sheet", "wave": "W3", "screens": ["M22", "M23", "M24"], "dependsOn": ["B1", "C2", "P6"], "nativeHooks": ["haptic", "scanQr"], "owns": [{"path": "components/security/device-link-dialog.tsx"}, {"path": "components/security/sas-emoji.tsx", "from": "C2"}, {"path": "components/security/fingerprint-box.tsx", "new": true}, {"path": "components/security/device-tile.tsx", "new": true}, {"path": "components/mobile/viewfinder.tsx", "new": true}]},
  {"id": "D2", "title": "Devices screen and device sheet", "wave": "W4", "screens": ["M25", "M26"], "dependsOn": ["D1", "E1"], "nativeHooks": ["haptic"], "owns": [{"path": "components/security/devices-panel.tsx"}, {"path": "components/security/host-trust.tsx"}, {"path": "components/security/devices-screen.tsx", "new": true}, {"path": "components/security/device-sheet.tsx", "new": true}]},
  {"id": "D3", "title": "Recovery key and security log screens", "wave": "W4", "screens": ["M27", "M28"], "dependsOn": ["C3", "E1"], "nativeHooks": ["haptic", "saveTextFile"], "owns": [{"path": "components/security/recovery-panel.tsx"}, {"path": "components/security/recovery-key-view.tsx", "from": "C3"}, {"path": "components/security/security-log.tsx"}]},
  {"id": "E1", "title": "Settings framework and list", "wave": "W2", "screens": ["M29"], "dependsOn": ["A1", "P2", "P3"], "nativeHooks": [], "owns": [{"path": "components/mobile/settings-host.tsx", "from": "A1"}, {"path": "components/mobile/section-tabs.tsx", "new": true}, {"path": "components/settings/settings-list.tsx", "new": true}, {"path": "components/settings/settings-screen.tsx", "new": true}, {"path": "components/settings/settings-model.tsx"}, {"path": "components/settings/save-bar.tsx"}, {"path": "stores/navStore.ts"}, {"path": "stores/navStore.test.ts"}, {"path": "stores/dialogStore.ts"}, {"path": "components/shell/dialogs.tsx"}, {"path": "components/settings/sign-out-sheet.tsx", "new": true}]},
  {"id": "E2", "title": "My account and appearance", "wave": "W3", "screens": ["M30", "M31"], "dependsOn": ["E1", "A3"], "nativeHooks": ["haptic"], "owns": [{"path": "components/settings/user/account.tsx"}, {"path": "components/settings/image-field.tsx"}, {"path": "components/settings/use-image-upload.ts", "new": true}, {"path": "components/settings/user/appearance.tsx"}, {"path": "components/settings/user/text-size.tsx", "new": true}, {"path": "stores/prefsStore.ts"}, {"path": "components/theme-provider.tsx"}, {"path": "components/chat/message-row.tsx", "from": "A3"}]},
  {"id": "E3", "title": "Sign-out sheet, status sheet, notifications and privacy", "wave": "W4", "screens": ["M33", "M34", "M35"], "dependsOn": ["E1", "I1"], "nativeHooks": ["haptic"], "owns": [{"path": "components/settings/sign-out-sheet.tsx", "from": "E1"}, {"path": "components/settings/status-sheet.tsx", "new": true}, {"path": "components/settings/user/notifications.tsx", "new": true}, {"path": "components/settings/user/privacy.tsx", "new": true}, {"path": "hooks/use-blocked-users.ts", "new": true}, {"path": "components/shell/me-button.tsx"}, {"path": "components/shell/dialogs.tsx", "from": "E1"}, {"path": "components/home-pane.tsx", "from": "I1"}, {"path": "services/guild-features.ts"}, {"path": "stores/userStore.ts"}, {"path": "components/settings/settings-model.tsx", "from": "E1"}]},
  {"id": "E4", "title": "Voice and audio settings", "wave": "W3", "screens": ["M32"], "dependsOn": ["E1"], "nativeHooks": [], "owns": [{"path": "components/settings/user/voice.tsx"}, {"path": "components/settings/user/sounds.tsx"}]},
  {"id": "F1", "title": "Pages channel on its chat and the pages drawer", "wave": "W4", "screens": ["M37", "M42"], "dependsOn": ["A2", "A5", "I2"], "nativeHooks": ["haptic"], "owns": [{"path": "components/mobile/page-bar.tsx", "new": true}, {"path": "components/mobile/mobile-chat-pane.tsx", "from": "A2"}, {"path": "stores/tabsStore.ts"}, {"path": "stores/tabsStore.test.ts"}, {"path": "components/chat/channel-intro.tsx", "from": "I2"}, {"path": "components/people/right-column.tsx", "from": "A1"}, {"path": "components/docs/pages-tree-list.tsx", "new": true}, {"path": "components/docs/page-tree-popover.tsx"}, {"path": "services/docs/page-tree.ts"}, {"path": "services/docs/page-tree.test.ts"}]},
  {"id": "F2", "title": "Page screen", "wave": "W5", "screens": ["M38"], "dependsOn": ["F1"], "nativeHooks": [], "owns": [{"path": "components/mobile/page-screen.tsx", "from": "A1"}, {"path": "components/docs/pages-panel.tsx"}, {"path": "components/docs/page-parts.tsx", "new": true}, {"path": "components/docs/page-hero.tsx", "new": true}, {"path": "components/docs/page-labels.tsx"}, {"path": "components/docs/page-editor.tsx"}, {"path": "components/docs/page-editor.css"}, {"path": "components/docs/page-editor-state.ts", "new": true}]},
  {"id": "F3a", "title": "Page editing toolbar and slash menu", "wave": "W6", "screens": ["M39", "M40"], "dependsOn": ["F2", "P4"], "nativeHooks": ["haptic"], "owns": [{"path": "components/docs/page-editor.tsx", "from": "F2"}, {"path": "components/docs/page-editor.css", "from": "F2"}, {"path": "components/docs/page-picker.tsx"}, {"path": "components/mobile/keyboard-toolbar.tsx", "new": true}, {"path": "components/docs/turn-into-sheet.tsx", "new": true}]},
  {"id": "F3b", "title": "Page actions sheet", "wave": "W6", "screens": ["M41"], "dependsOn": ["F2"], "nativeHooks": ["haptic", "share"], "owns": [{"path": "components/mobile/page-screen.tsx", "from": "F2"}, {"path": "components/docs/page-actions.tsx", "new": true}, {"path": "components/docs/page-links.ts"}, {"path": "components/docs/page-links.test.ts"}]},
  {"id": "G1", "title": "Guild menu sheet", "wave": "W3", "screens": ["M43"], "dependsOn": ["P6", "A1"], "nativeHooks": [], "owns": [{"path": "components/shell/guild-header.tsx"}, {"path": "components/shell/guild-menu-items.tsx"}, {"path": "lib/notify.ts"}, {"path": "components/notify/notify-menu.tsx", "from": "A2"}]},
  {"id": "G2a", "title": "Add a guild and join with invite", "wave": "W4", "screens": ["M44", "M45"], "dependsOn": ["P6", "I1", "E1"], "nativeHooks": [], "owns": [{"path": "components/add-server-dialog.tsx"}, {"path": "components/join-server-modal.tsx"}, {"path": "components/chat/message-tokens.tsx"}, {"path": "stores/dialogStore.ts", "from": "E1"}, {"path": "components/shell/tile-row.tsx", "from": "A5"}, {"path": "components/shell/sidebar-rows.tsx", "from": "I1"}]},
  {"id": "G2b", "title": "Invite, create channel, leave and delete", "wave": "W6", "screens": ["M46", "M47", "M50", "M51"], "dependsOn": ["P6", "G2a", "E3", "J2"], "nativeHooks": ["share"], "owns": [{"path": "components/invite-dialog.tsx"}, {"path": "components/create-channel-dialog.tsx"}, {"path": "components/remove-server-dialog.tsx"}, {"path": "components/shell/dialogs.tsx", "from": "E3"}, {"path": "stores/dialogStore.ts", "from": "G2a"}, {"path": "components/sidebar/channel-row.tsx", "from": "J2"}, {"path": "components/sidebar/guild-channels.tsx", "from": "A5"}, {"path": "lib/model.ts"}]},
  {"id": "G3", "title": "Channel settings and permissions", "wave": "W3", "screens": ["M48", "M49"], "dependsOn": ["E1", "A2"], "nativeHooks": [], "owns": [{"path": "components/settings/channel-overview.tsx"}, {"path": "components/settings/channel-permissions.tsx"}, {"path": "components/mobile/chip-scroller.tsx", "new": true}]},
  {"id": "H1", "title": "Guild overview", "wave": "W4", "screens": ["M52"], "dependsOn": ["E1", "E2"], "nativeHooks": ["haptic"], "owns": [{"path": "components/settings/guild-overview.tsx"}, {"path": "components/settings/guild-overview-mobile.tsx", "new": true}, {"path": "components/region-select.tsx"}]},
  {"id": "H2", "title": "Roles", "wave": "W4", "screens": ["M53"], "dependsOn": ["E1"], "nativeHooks": ["haptic"], "owns": [{"path": "components/guild-settings-roles.tsx"}, {"path": "components/settings/guild-roles-mobile.tsx", "new": true}, {"path": "components/settings/use-role-list.ts", "new": true}, {"path": "components/settings/hoist-row.tsx"}, {"path": "components/ui/permission-row.tsx"}]},
  {"id": "H3", "title": "Members", "wave": "W4", "screens": ["M54"], "dependsOn": ["E1"], "nativeHooks": ["haptic"], "owns": [{"path": "components/guild-settings-members.tsx"}, {"path": "components/settings/guild-members-mobile.tsx", "new": true}]},
  {"id": "H4", "title": "Invites", "wave": "W5", "screens": ["M55"], "dependsOn": ["E1", "E3"], "nativeHooks": ["haptic"], "owns": [{"path": "components/guild-settings-invites.tsx"}, {"path": "components/settings/guild-invites-mobile.tsx", "new": true}, {"path": "components/settings/use-guild-invites.ts", "new": true}, {"path": "components/settings/invites.ts"}, {"path": "components/settings/invites.test.ts"}, {"path": "components/settings/invite-options.tsx"}, {"path": "services/InviteService.ts"}, {"path": "components/settings/settings-model.tsx", "from": "E3"}]},
  {"id": "I1", "title": "DM list and DM home", "wave": "W3", "screens": ["M8", "M56"], "dependsOn": ["A1", "A5", "P6"], "nativeHooks": ["haptic"], "owns": [{"path": "components/sidebar/dm-space.tsx"}, {"path": "components/home-pane.tsx"}, {"path": "components/people/active-now.tsx"}, {"path": "components/voice/live-card.tsx"}, {"path": "components/ui/presence.tsx"}, {"path": "components/shell/user-avatar.tsx"}, {"path": "components/shell/sidebar-rows.tsx", "from": "A5"}, {"path": "lib/time-format.ts"}, {"path": "lib/time-format.test.ts"}, {"path": "components/mobile/dm-home-screen.tsx", "new": true}]},
  {"id": "I2", "title": "DM header, intro and trust", "wave": "W3", "screens": ["M7", "M57"], "dependsOn": ["A2", "B1"], "nativeHooks": ["haptic"], "owns": [{"path": "components/mobile/mobile-channel-header.tsx", "from": "A2"}, {"path": "components/people/trust-chip.tsx"}, {"path": "components/people/trust-look.ts"}, {"path": "components/people/trust-look.test.ts"}, {"path": "components/people/dm-profile-column.tsx"}, {"path": "components/people/use-mutual-guilds.ts", "new": true}, {"path": "components/chat/channel-intro.tsx"}, {"path": "components/chat/key-card.tsx", "new": true}, {"path": "pkgs/hachiman-crypto/src/bridge/stub.ts"}]},
  {"id": "I3", "title": "Key change dialog and notice line", "wave": "W4", "screens": ["M58", "M59"], "dependsOn": ["I2", "A6", "P6"], "nativeHooks": ["haptic"], "owns": [{"path": "components/security/key-change-dialog.tsx"}, {"path": "stores/cryptoStore.ts"}, {"path": "stores/cryptoStore.test.ts"}, {"path": "components/security/security-notices.tsx"}, {"path": "components/chat/composer.tsx", "from": "A6"}, {"path": "components/chat/chat-body.tsx", "from": "A2"}, {"path": "components/chat/key-change-line.tsx", "new": true}, {"path": "components/chat/format.ts"}, {"path": "components/chat/format.test.ts"}, {"path": "components/chat/transcript.tsx", "from": "A3"}, {"path": "pkgs/hachiman-crypto/src/bridge/stub.ts", "from": "I2"}]},
  {"id": "J1", "title": "Channel states", "wave": "W5", "screens": ["M60", "M61", "M62", "M63"], "dependsOn": ["I3", "G1", "F1"], "nativeHooks": ["haptic"], "owns": [{"path": "components/chat/channel-intro.tsx", "from": "F1"}, {"path": "components/notify/notify-menu.tsx", "from": "G1"}, {"path": "components/chat/composer.tsx", "from": "I3"}, {"path": "components/chat/chat-body.tsx", "from": "I3"}, {"path": "components/mobile/mobile-channel-header.tsx", "from": "I2"}]},
  {"id": "J2", "title": "Voice channel not joined", "wave": "W5", "screens": ["M64"], "dependsOn": ["B2", "I1", "A5"], "nativeHooks": [], "owns": [{"path": "components/voice/voice-room.tsx", "from": "B2"}, {"path": "components/voice/live-card.tsx", "from": "I1"}, {"path": "components/voice/voice-occupant-row.tsx", "new": true}, {"path": "components/sidebar/channel-row.tsx", "from": "A5"}]},
  {"id": "J3", "title": "Full-screen search", "wave": "W4", "screens": ["M66"], "dependsOn": ["A1", "P2"], "nativeHooks": ["haptic"], "owns": [{"path": "components/shell/quick-switcher.tsx"}, {"path": "components/shell/switcher-state.ts"}, {"path": "lib/quick-switcher.ts"}, {"path": "lib/quick-switcher.test.ts"}, {"path": "components/mobile/search-screen.tsx", "new": true}]},
  {"id": "J4", "title": "Inbox screen", "wave": "W4", "screens": ["M67"], "dependsOn": ["A1", "P2"], "nativeHooks": ["haptic"], "owns": [{"path": "components/inbox/inbox-button.tsx"}, {"path": "components/inbox/inbox-screen.tsx", "new": true}, {"path": "components/inbox/inbox-model.ts"}, {"path": "components/inbox/inbox-model.test.ts"}, {"path": "services/UnreadService.ts"}]}
]}
```

## 5. Features the mocks show that do not exist yet

These are product features. Each one is a separate PR with its own server, contract or crypto work. The port hides the control until the feature lands. It never ships a dead button. A change to `pkgs/hachiman-crypto/src/api.ts` needs the matching contract §12 change in the same PR.

| Feature | What it needs | Screens | Hidden until it lands |
|---|---|---|---|
| Voice messages (hold to record) | MediaRecorder capture, encrypted upload, playback exists | M1, M6, M7, M11, M57, M60 | the Record button. Send shows with text, the slot is empty without |
| Bots and rich embeds (N22) | a bot flag on `User`, an embed content kind | M1, M4, M11, M54, M62, M63 | the BOT tag and embed cards (sample content only) |
| Camera in calls (N19) | a video track in `VoiceConnection` and `VoiceService` | M2, M8, M10, M12, M65 | the Camera button |
| Screen share from iOS | a ReplayKit broadcast extension | M2, M8, M10, M12, M65 | Share Screen on iOS (`canShareScreen()`) |
| Text chat in voice channels | server accepts messages in voice channels | M10, M64, M65 | the "Voice chat" header button |
| `@here` mention | `components/chat/mention-items.ts`, `lib/mentions.ts` rule for online receivers | M6 | the @here row |
| Mark unread | a backward ack or a mark-unread op with `READ_STATE_UPDATE`, contract §4 | M5 | the Mark unread row |
| Report message | UI wiring of `RestClient.report` and `CryptoApi.buildReport`, a reason sheet | M5 | the Report row |
| Push notifications | APNs, a registration route, E2EE-safe payloads, server-stored notify prefs | M33 | PUSH NOTIFICATIONS, LOCK SCREEN, QUIET HOURS sections, timed mutes |
| DM policy, message requests, read receipts, typing and status visibility | server settings and contract | M34 | WHO CAN DM YOU, Message requests, WHAT OTHERS SEE |
| Presence hidden from blocked users | a gateway block filter | M34 | the "see your status" part of the note |
| Display name, About, avatar colour | `User` fields, `PATCH /users/@me`, migration, events | M30 | Colour row, Display name, About, Save |
| Settings search, Help URL | a settings index, a configured help URL | M29 | the search action, Help and support row |
| Output device choice on iOS | a native route picker hook (`AVRoutePickerView`) | M32 | the Output device row on iOS |
| Dynamic Type for menus | rem sizing or a native content-size hook | M31 | the "Menus follow your iPhone's text size" note |
| Per-device fingerprint | a `DeviceSummary` and `ContactDevice` fingerprint from the certificate key, §12.5 | M9, M24, M26 | fingerprint lines and boxes |
| Device OS, model, browser version, location, "linked from" | signed or stored device data. Location is not recommended | M9, M25, M26, M35 | those meta lines |
| `clientVersion` in `DeviceSummary` | an `pkgs/hachiman-crypto/src/api.ts` change | M26 | the App row shows the platform label only |
| "Has security key" on other devices | a record of which device holds the master key | M25 | the chip on other devices |
| Recovery key date and device | an API for `key_backups.created_at` | M27, M35 | "Made 12 Sep 2026 on …" |
| KT log timeline with verdicts, "Signed by", last check time | new `CryptoApi` methods, §12.14 | M28 | "Signed by", "Last checked", "n of n" |
| QR expiry from the server | `expiresAt` in `LinkStart` | M17 | "New code in 0:48" (a client countdown shows instead) |
| Keep awake while linking | `navigator.wakeLock` or a native idle-timer op | M17 | nothing hidden. The phone can lock |
| Local-only secret copy, native clipboard | `UIPasteboard` local-only op, seam §11 | M19, M27, M55 | nothing hidden. Plain copy is used |
| Live QR viewfinder in a sheet | a JS QR decoder or a native preview layer | M22 | the live preview (a launcher tile shows) |
| Contact key fingerprint, earlier verify date, persisted key-change severity | `TrustInfo` fields, §12.5 | M57, M58, M59 | the fingerprint in the key card, the key compare box, the date in the sub line |
| Key-change history entry | a new timeline kind, §12.16 | M59 | the line after acknowledgement |
| Invite online count, banner, landing channel | `InvitePreview` fields, `Invite.channelId`, contract §4 | M45, M46, M52 | "12 online", the banner, "Lands in #channel" |
| Private channel at create, lowercase names | a create-private path, a slug rule | M47 | the private toggle, the lowercase helper |
| Owner leave with transfer | an ownership transfer route | M43 | Leave for owners |
| Page activity in chat | a product decision. #53 removed it | M37 | the activity card and "is editing" line |
| Page last edit and editor | new page fields and contract. `Page.updatedAt` changes only on a title, parent or position patch, not on a content edit | M37, M38, M42 | "Edited just now by …" |
| Page cover and icon | fields in the encrypted Y.Doc meta map | M38 | stored covers (a computed hero shows) |
| Comments | a design and storage | M38, M39, M41 | Comments button, tool and row |
| Callout and toggle blocks, chat quote block, member mentions in pages | new ProseMirror nodes for every client at once | M38, M39, M40 | those slash items |
| Page history, duplicate, lock, cross-channel move, PDF, trash, templates, recently edited | page features of plan 5.6 | M41, M42 | those rows and sections |
| Threads in pages channels | a contract change | M37 | the Threads chip in pages channels |
| Message search, recent queries | an encrypted local index. Queries must not go to `localStorage` in plaintext | M66 | Messages and From chips, MESSAGES, RECENT queries, Clear |
| Inbox replies, invites, history | reply tracking, invite notices, a kept history | M67 | Replies and Invites chips, EARLIER |
| Stream duration, per-viewer watching, receive-only watch | stream start time, viewer state, a no-mic join | M64 | "42 min", "n watching". Watch stream still opens the mic |
| "Speaking in" for other calls | speaking state outside your own call | M7, M57 | the line says "In <channel>" |
| DM previews after a cold start | a stored preview | M56 | the preview line for unloaded DMs |
| A `share` with text alone or a file | `ShareContent.url` optional, or a file, seam §11. Today `url` must be http(s) (`apps/hachiman-ios/Hachiman/Bridge.swift` `webURL`) and `text` rides only beside it | M41 | Export shares only after the seam lands. Copy markdown works |

## 6. Risks and open questions

### 6.1 Open questions for the user

1. **Confirmations as sheets or centred dialogs.** The spec text says sheets. M50, M51 and M58 draw centred dialogs. This spec follows the drawings. Confirm.
2. **Page edits in the chat.** M37 and desktop C1 show page activity in the chat. #53 removed it. Bring it back on both layouts, or drop it from the mocks?
3. **Desktop side effects that the captions ask for.** Newest-first DM list, the PAGE tag and violet icon, the gold "Not verified" look for notice changes, lit and marked rows under open dialogs, the spelled-out invite expiry. This spec lets the DM order, the PAGE tag and the trust look change on desktop. The lit and marked states are mobile-only until you agree.
4. **Delete without confirm on invites.** Desktop deletes an invite at once. On touch, Copy and Delete sit 6 px apart. This spec adds a confirm on touch only.
5. **Settings "Advanced" on a phone.** The mock leaves it out. It is the only reset path on a phone with no devtools. This spec keeps it as the last Help row.
6. **Soundboard in the call bar.** M10 has no slot for it. This spec moves it into a "More" sheet.
7. **Host trust callout rule.** Showing the gold callout when any own device is a browser also changes desktop H2 if shared. Desktop follows or not?

**Decisions for the first build** (the user reviews them in the PR):

1. Follow the drawings: M50, M51 and M58 are centred dialogs. All other dialogs are sheets.
2. No page activity in the chat. #53 removed it on purpose, so the build does not add it back. M37 shows no edit lines.
3. Mobile only: the newest-first DM list, the PAGE tag and violet icon, the gold "Not verified" look, the lit and marked rows under open dialogs and the spelled-out invite expiry. The desktop does not change.
4. A confirm on touch only, as proposed.
5. Keep "Advanced" as the last Help row, as proposed.
6. The soundboard goes into a "More" sheet, as proposed.
7. Mobile only. Desktop H2 does not change.

### 6.2 Risks

- **Gesture conflicts.** Edge swipe (drawer or back), swipe down (sheets), sideways scrollers (tabs, chips, role strip) and touch drags (reorder) all compete. Section 2.4 and 2.9 set the order. Test on a device early.
- **dnd-kit on touch.** Today a 4 px `PointerSensor` turns every scroll of the tab strip or a manager's channel list into a drag. A5 must land before the drawer is usable for managers.
- **Radix ContextMenu.** It opens after a 700 ms touch hold. If P6 misses one trigger, two menus open. Search all `ContextMenuTrigger` uses after P6.
- **WKWebView keyboard.** Focus outside a gesture does not raise the keyboard. `visualViewport` lags the animation. The accessory-bar override uses a private class (App Review risk). Check in the simulator in P1 and P4.
- **Focus zoom.** Any field under 16 px zooms. P1 sets 16 px in CSS and P4 sets `maximum-scale=1`.
- **Clipboard.** `writeText` after an await can fail in WebKit. For an invite with history the link is then lost (H4). The P4 probe tells us what works under `hachiman://app`.
- **Background kills.** WebKit can kill the content process in the background. The in-memory key-change severity is then lost, and the blocking dialog and paused composer go away while trust stays "changed". This needs the `TrustInfo` severity field (section 5) before I3 can be fully correct.
- **Mark-read under overlays.** Read state follows window focus only. A3 adds `visibilitychange` and `useChatCovered()`. Without this, a page screen or drawer marks messages read that the user did not see.
- **Sign-out removes keys on the phone.** Only the M35 confirm may call `signOutDevice()`. A token refresh failure must never do it.
- **Recovery key loss.** The new-key sheet must not close on a drag or scrim tap while the key shows. The old key already stopped working.
- **Performance.** The transcript is not virtualized. Drawers re-render on presence events if they mount early. Each `useContactTrust` caller makes a Worker round trip, so lift it to one hook per DM. The page editor chunk is large: keep it lazy. Member lists in large guilds need `content-visibility` or windowing.
- **E2EE fidelity.** No stream thumbnail for non-members. The call code stays 30 digits. Search indexes and saved queries never go to `localStorage` in plaintext. A share or export hands decrypted text to the OS only on a user action.
- **Mock errors to ignore.** 8 SAS emoji (the protocol has 7). A 48-character recovery key (the real one is 55). A 16-digit call code (30). A "guilds" OIDC scope that does not exist. "7 days" invite default (1 day for non-admins). Swatch colours that differ from the stored role colours.
- **Merge churn.** Other agents build in this tree. `components/settings/settings-model.tsx`, `components/security/devices-panel.tsx`, `components/security/device-link-dialog.tsx`, `components/security/security-log.tsx`, `components/sign-in-screen.tsx` and `shared/IPlatformService.ts` already carry uncommitted Phase 4 changes. Keep the wave order and the ownership lists strict.
- **Accessibility.** Every gesture needs a button. Drawers and sheets need a focus trap, focus return, an inert background and a labelled close. Icon-only trust buttons need the state in the label. Respect reduced motion. Pixel sizes ignore Dynamic Type in WKWebView.
- **Preview gaps.** The crypto stub returns trust "unknown". I2 and I3 add fixtures. Voice, scanning, haptics and the keyboard need the simulator.
