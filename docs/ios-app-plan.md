# Plan: `apps/hachiman-ios`, a native WKWebView host + TestFlight alpha

## Context

Hachiman has two hosts today: Electron (`apps/hachiman-electron`) and the browser (`apps/hachiman-browser`). Both render the one shared React UI (`@hachiman/hachiman`) and differ only through `IPlatformService` (`apps/hachiman/src/shared/IPlatformService.ts`, contract §11). We want an iPhone app for alpha testers via TestFlight. It is a third host: a native Swift shell around a `WKWebView` that runs the same shared UI, bundled inside the app. Android comes later, out of scope.

This plan covers the native structure, the seam work, and TestFlight distribution. **Mobile UI changes follow the user's pen.dev mocks (frame "Final - Mobile", Phase 5).** Branch `ios-app` from `main` (not from PR #74), one draft PR.

### Key facts from exploration
- Takusen CORS rejects `Origin: null` (`apps/takusen/src/lib/allowed-origins.ts`), so `file://` cannot work. Electron serves the app on the custom scheme `hachiman://app` for this reason (`apps/hachiman-electron/src/main/renderer-protocol.ts`), and `hachiman://app` is already in `DEFAULT_ALLOWED_ORIGINS`. iOS reuses that exact origin through a `WKURLSchemeHandler`: no CORS change.
- `app.hachiman://oauth-callback` is already a registered redirect URI (seed `apps/takusen/src/db/seed.ts`, `DESKTOP_OAUTH_CALLBACK` in `lib/deployment.ts`). iOS uses it directly with `ASWebAuthenticationSession` (callback scheme `app.hachiman`): no Takusen bridge page, no seed change.
- Hard web-platform requirements of the shared code (all fail closed when missing):
  - `RTCRtpScriptTransform` (voice SFrame, `apps/hachiman/src/services/client.ts:31`, `pkgs/hachiman-client/src/voice.ts:611,692`)
  - Web Locks (`pkgs/hachiman-crypto/src/bridge/index.ts:27-48`)
  - module Workers
  - WebCrypto **Ed25519 and X25519** (ts-mls uses native subtle when present; `@hpke/core` X25519)
  - `CryptoKey` structured clone into IndexedDB and `postMessage`
  - AudioWorklet + wasm (RNNoise, CSP `'wasm-unsafe-eval'`)
  - Opus and VP8 (`voice-e2ee.ts:59-63`)

  These set the **minimum iOS to 17** (native Ed25519/X25519 in WebKit). Phase 1 verifies each one in a real WKWebView before anything else.
- Not available in iOS WKWebView: `getDisplayMedia` (no screen share; later via a ReplayKit extension; watching a share works) and `BarcodeDetector` (QR scanning gets a native scanner, Phase 5.5; the phone *shows* QR codes fine).
- Web Notifications, service workers and push are not used anywhere, so there is nothing to port for this alpha.

## Phase 0: Branch and skeleton
1. `git switch -c ios-app origin/main`.
2. Open a draft PR "iOS app (WKWebView host)" early, and update it per phase.

## Phase 1: Capability spike (go / no-go)
Before any seam work, a throwaway `probe.html` in the app bundle reports in the WKWebView:
- `RTCRtpScriptTransform`
- `navigator.locks`
- module Worker
- `crypto.subtle.generateKey('Ed25519')` and `X25519`
- a `CryptoKey` put into and read from IndexedDB, and posted to a Worker
- `AudioWorklet` + wasm
- `RTCRtpReceiver.getCapabilities('video')` contains VP8
- `getUserMedia` audio from the `hachiman://app` origin

Run it on the iOS 17 and 18 simulators and on one physical iPhone. A failed hard requirement stops the plan and goes back to the user. The probe is deleted after Phase 2.

## Phase 2: Native project `apps/hachiman-ios`

Layout (one package, web build + Swift):
```
apps/hachiman-ios/
  package.json            @hachiman/hachiman-ios: dev, build (tsgo --noEmit && vite build), typecheck, lint, test
  vite.config.ts          copy of hachiman-browser's: @/ alias → ../hachiman/src, envDir = repo root, worker.format 'es', CSP <meta> plugin
  index.html              viewport-fit=cover
  csp.ts                  reuses cspFromEndpoints (as apps/hachiman-browser/csp.ts does)
  src/main.tsx            same mount as apps/hachiman-browser/src/main.tsx with the iOS PlatformService
  src/platforms/ios/PlatformService.ts   JS side of the bridge
  src/platforms/ios/bridge.ts            typed wrapper over window.webkit.messageHandlers.hachiman (postMessage with reply)
  project.yml             XcodeGen spec (the .xcodeproj is generated, git-ignored)
  Hachiman/
    HachimanApp.swift     SwiftUI @main, onOpenURL → deep links
    WebView.swift         UIViewRepresentable WKWebView (configuration below)
    AppSchemeHandler.swift  WKURLSchemeHandler for hachiman://app → files in the bundled WebApp/ folder
    Bridge.swift          WKScriptMessageHandlerWithReply: dispatch by "op"
    WrapKeyStore.swift    Keychain store of the per-user wrap key
    OAuth.swift           ASWebAuthenticationSession
    AudioSession.swift    AVAudioSession playAndRecord / voiceChat while in a call
    Info.plist, Assets.xcassets (icon placeholder), Hachiman.entitlements
  HachimanTests/          XCTest: scheme handler path guard, WrapKeyStore, bridge origin check
  ExportOptions.plist     app-store-connect export for TestFlight
  README.md               architecture diagram + dev and release steps (as the other app READMEs)
```
- **XcodeGen:** a reviewable YAML spec instead of a committed `project.pbxproj` (`brew install xcodegen`; CI does the same). Deployment target iOS 17.0, iPhone only for the alpha, bundle id from a build setting (`HACHIMAN_BUNDLE_ID`, placeholder `app.hachiman.ios`).
- **Web bundle into the app:** an Xcode "Copy WebApp" run-script phase copies `apps/hachiman-ios/dist` into `Hachiman.app/WebApp/`. It fails the build with a clear message when `dist` is missing. `pnpm -F @hachiman/hachiman-ios build` runs first (locally and in CI).
- **WKWebView configuration (`WebView.swift`):**
  - `setURLSchemeHandler(AppSchemeHandler, forURLScheme: "hachiman")`, then load `hachiman://app/index.html`.
  - The persistent `WKWebsiteDataStore.default()` (IndexedDB crypto store and wrap state must survive restarts).
  - `allowsInlineMediaPlayback = true`, `mediaTypesRequiringUserActionForPlayback = []`.
  - `isInspectable = true` only in Debug (Safari Web Inspector).
  - `WKUIDelegate.requestMediaCapturePermissionFor`: grant only for origin `hachiman://app` in the main frame (the OS still shows its own mic and camera prompt).
  - `WKNavigationDelegate`: allow only `hachiman://app/*`. Open `http(s)` links externally (`UIApplication.open`), and cancel everything else.
- **`AppSchemeHandler`:**
  - Serve only files under `WebApp/`: normalize the path, reject `..` and anything outside the folder, SPA fallback to `index.html`.
  - Correct MIME types (`.js`, `.wasm` = `application/wasm`, `.css`, ...).
  - The CSP is in the `<meta>` tag from the Vite plugin (as the browser host); the `frame-ancestors`/`sandbox` parts don't apply to a WKWebView.
- **Bridge (`Bridge.swift` + `bridge.ts`):** one handler name, `hachiman`; messages `{op, ...}`, replies through `WKScriptMessageHandlerWithReply`. Each message is checked: `frameInfo.isMainFrame` and `securityOrigin` = `hachiman://app`, else rejected. Ops:
  - `wrapKey.get {userId}` → 32 bytes (base64). Keychain generic password, service `hachiman.wrap-key`, account `userId`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, not synchronizable. Created on first call and never replaced (same rules as `apps/hachiman-electron/src/main/secure-storage.ts`). A Keychain failure → `SecureStorageUnavailable`.
  - `wrapKey.clear {userId}`.
  - `oauth.begin {url}`: `ASWebAuthenticationSession(callbackURLScheme: "app.hachiman")`, `prefersEphemeralWebBrowserSession = false`. The callback URL goes to JS as an event.
  - `haptic`, `share`, `scanQr`, `setAppearance`: the hooks the mobile mocks need (Phase 5.5).
  - Events native → JS (`window.__hachimanNative.emit(type, payload)` via `evaluateJavaScript`, buffered until the page subscribes, as the Electron preload does): `oauth-callback`, `invite-link`.
- **Deep links:** register the URL schemes `takusen` (invites, as Electron) and `app.hachiman` (OAuth) in Info.plist. `onOpenURL` → `invite-link` event; the JS side parses with `parseInviteLink` (`apps/hachiman/src/lib/invite-link`). Universal links for `https://<domain>/invite/...` need an `apple-app-site-association` file served by Takusen: listed as a follow-up.
- **Audio:** `AVAudioSession.playAndRecord`, mode `.voiceChat`, options `.allowBluetooth` and `.defaultToSpeaker`, activated by the first `getUserMedia`. ponytail: no CallKit and no background voice in the alpha. WKWebView pauses capture when the app goes to the background. CallKit or native WebRTC is the upgrade path if background calls matter.
- **Info.plist:**
  - `NSMicrophoneUsageDescription`, `NSCameraUsageDescription` (avatar and image picking; QR later)
  - `ITSAppUsesNonExemptEncryption` (see Phase 6)
  - ATS: `NSAllowsLocalNetworking` in Debug only (simulator → `localhost` dev servers)

## Phase 3: JS PlatformService for iOS (`src/platforms/ios/PlatformService.ts`)
Mirror `apps/hachiman-browser/src/platforms/browser/PlatformService.ts`; reuse its `buffered()` listener helper (move it to the shared UI if both hosts need it, otherwise copy the few lines):
- `platform: 'ios'`, `insetTitleBar: false`, `oauthRedirectUri: 'app.hachiman://oauth-callback'`
- `beginOAuth` → `oauth.begin`
- `onOAuthCallback` / `onInviteLink` ← native events
- `probeRegions` → `[]` (later: a native TCP probe, as Electron `region-probe.ts`)
- `getScreenSources` → `null`, `selectScreenSource` no-op, `screenShareAudio: false`
- `checkForUpdate` → `not-available` (TestFlight updates the app)
- `closeToTray: null`, `setGlobalShortcuts` → `null`, `onGlobalShortcut` no-op
- `haptic`, `share`, `scanQr`, `setAppearance` → the bridge ops of Phase 5.5
- `secureStorage`:
  - backend `'os-keychain'`
  - `getWrapKey` = bridge bytes → `crypto.subtle.importKey('raw', ..., 'AES-GCM', false, ['encrypt','decrypt'])`, then zero-fill the byte copy (same as `apps/hachiman-electron/src/renderer/src/PlatformService.ts:42-69`)
  - `clear` → `wrapKey.clear`

## Phase 4: Seam and contract changes for the new platform value
One change set, contract in the same commit (CLAUDE.md rule):
- **Shared UI:**
  - `IPlatformService.platform: 'electron' | 'browser' | 'ios'`
  - `CryptoService.ts:114-116` (platform and deviceName "Hachiman iOS")
  - The `platform === 'electron' | 'browser'` branches: `settings-model.tsx:112`, `keybinds.tsx:34` (no keybinds on iOS), `use-sign-in.ts:28`, `sign-in-screen.tsx:49`, `fatal-screen.tsx`
  - Device labels and icons: `devices-panel.tsx`, `security-log.tsx`, `device-link-dialog.tsx`
- **Client:** `DevicePlatform` in `pkgs/hachiman-client/src/types.ts:369`.
- **Crypto:** `DevicePlatform` in `pkgs/hachiman-crypto/src/api.ts:101`; `identity/codec.ts` `PLATFORM` adds `ios: 3` (a LinkOffer wire value); spec and fuzz generators.
  - `identity/service.ts:136` host trust: **deliberately `'strong'`** for iOS, because the code ships inside the signed app as in Electron, not served by Takusen. Contract §12.17 text gets an "iOS host" line.
- **Takusen:**
  - `device_platform` enum adds `'ios'`: schema + a new drizzle migration (`ALTER TYPE ... ADD VALUE`, stacked, never edit 0000)
  - `api/v1/devices/route.ts` zod enum
  - the dashboard label
  - `oidc-consent.ts` redirect kind label (shows "desktop" today for any custom scheme; give `app.hachiman` from iOS a neutral "app" label)
- **Contract `docs/gateway-protocol.md`:** §3 enum (l.293), §11 platform and the iOS host section, §12.12 LinkOffer `3 ios`, `POST /devices`, `Device`, §12.17 host trust.
- **Docs:** CLAUDE.md monorepo layout and host list; `apps/hachiman-ios/README.md`; top-level README diagram gets the third host.

## Phase 5: Mobile UI (from the "Final - Mobile" pen.dev board)

Source: the pen.dev document, frame **Final - Mobile** (`GZi9q`): 6 rules, the behaviour specs, the mobile kit (`01 · Mobile kit`) and 67 phone screens M1–M67 (`02 · Screens`, rows A–J, 393 × 852, dark plus light M11/M12). Each screen caption names the desktop page it ports, so this phase is mostly re-layout of existing shared-UI pages, not new pages. All work is in `apps/hachiman/src`, behind one switch, so desktop and browser stay unchanged.

### 5.1 The mobile shell (rules 01–06)
- **Switch:** a mobile layout when `useIsMobile()` (`hooks/use-mobile.ts`, today unused) is true, and always on the iOS host. One `MobileShell` beside `components/shell/shell.tsx`, not `if (mobile)` branches spread through the desktop shell.
- **Chat is the screen (rule 01):** the conversation edge to edge. Pinned tabs in a sideways strip on top (Mobile / Tab Strip, 48), the channel header (56) with threads, pins and members, the composer (60) at the foot.
- **Sidebar as a drawer (rule 02):** the existing sidebar (`components/shell/sidebar.tsx`, the same Sidebar Top, guild row, channel list and voice dock) slides over the chat at 320 px with a 65 % scrim (35 % in light). Open with a swipe right from the left 24 px or the sidebar button. Close by tapping the scrim, swiping left, or the close button. 250 ms, never pushes the chat. The open tab and scroll position stay.
- **Members and pages from the right (rule 03):** the right column (`lib/right-column` model) as the same 320 px drawer from the right; swipe left or the members button.
- **Voice bar (rule 04):** while connected, Mobile / Voice Bar (52) sits on the composer with mute, deafen and leave; tap opens the stage (M10). The full voice dock stays at the foot of the drawer.
- **Pages open on their chat (rule 05):** a violet bar under the header opens the page (M37); the pill on the page goes back.
- **Pushed screens and sheets (rule 06):** settings, devices and guild admin push in from the right with a back button (Mobile / Nav Bar 52, List Row 54, one 48 primary at the foot). Choices, confirmations and key checks rise as square sheets (Mobile / Sheet Header). Today's dialogs (`components/ui` dialog) render as sheets on mobile through one wrapper, not per dialog.

### 5.2 Mobile kit → components
Build the kit once in `components/mobile/` and map each pen.dev component:
- `Mobile / Status Bar` and `Mobile / Home Indicator` → the safe areas, not drawn: `env(safe-area-inset-top/bottom)` plus `viewport-fit=cover` (status 54, home 34).
- `Mobile / Tab Strip` → the pinned tabs (`components/shell/` tab bar) as a horizontal scroller: tap to switch, hold to reorder or unpin, the open tab scrolls into view.
- `Mobile / Nav Bar`, `Mobile / List Row`, `Mobile / Section Label`, `Mobile / Sheet Header`, `Mobile / Field`, `Mobile / Button · Primary/Secondary/Danger/Quiet` → mobile sizes of the existing `components/ui` primitives (variants, not new primitives).
- `Mobile / Composer`, `Mobile / Voice Bar`, `Mobile / Keyboard` → the composer and voice bar above (the keyboard is the OS one).
- Touch rules: nothing touchable under 36 px, primary buttons 48, tabs 34 in a 48 strip, channel rows 38, DM rows 48, call controls 52. Structure square, touch targets rounded.

### 5.3 Interaction specs
- **Message actions (M5):** hold 400 ms → light haptic, the message lifts, a sheet with quick reactions and the message actions. Replaces the hover toolbar and right-click menus (also on member rows and tiles).
- **Keyboard (M6):** the composer rides on the keyboard (`visualViewport` resize), the voice bar tucks away, `@` suggestions open above the composer.
- **Swipes:** left-edge swipe opens the sidebar, swipe left opens members. The WKWebView back/forward gestures stay off (`allowsBackForwardNavigationGestures = false`) so they don't fight.

### 5.4 Screen inventory (each caption names its desktop source)
| Row | Screens | Work |
|---|---|---|
| A · Main chat | M1 #general, M2 sidebar open, M3 guild grid, M4 members, M5 long press, M6 typing a mention | The shell, drawers, long press, keyboard |
| B · DMs and voice | M7 DM, M8 sidebar in DMs, M9 verify (safety number sheet), M10 voice stage, M11–M12 light theme | DM header warning, voice stage with docked controls, light theme check |
| C · Sign in and set up | M13 welcome, M14 Takusen in the secure browser sheet, M15 consent, M16 set-up paths as radio cards, M17 link (QR + emoji), M18 restore, M19 new identity, M20 reset, M21 done | Re-layout of `components/security/onboarding*`. M14 is `ASWebAuthenticationSession` (Phase 2). M16 makes linking first and recommended, reset a quiet line |
| D · Devices and keys | M22 link a new device (Scan / Compare emoji tabs, paste fallback), M23 compare emoji, M24 linked, M25 devices, M26 device details sheet, M27 recovery key, M28 security log | M22's Scan tab needs the native QR scanner (5.5). M26 moves rename and sign out into a sheet |
| E · Settings | M29 settings list, M30 my account, M31 appearance, M32 voice and audio, M33 notifications, M34 privacy and safety, M35 sign out sheet | Pushed screens over the existing `components/settings/*` pages. M33 and M34 are new (5.6) |
| F · Pages | M36–M37 pages channel on its chat, M38 page, M39 editing with a block toolbar on the keyboard, M40 `/` menu, M41 page actions sheet, M42 pages tree | Mobile layout of `components/docs/*` (Milkdown Crepe). The keyboard toolbar is new UI. M41/M42 list features that don't exist (5.6) |
| G · Guilds and channels | M43 guild menu, M44 add guild, M45 join with invite, M46 invite people (Copy and Share), M47 create channel, M48 channel settings, M49 permissions (three-way switch), M50 leave, M51 delete | Sheets and pushed screens over existing dialogs. M46 Share uses the native share sheet (5.5) |
| H · Guild settings | M52 overview (incl. the welcome channel from PR #74 when merged), M53 roles, M54 members, M55 invites | The settings list becomes tabs on the window |
| I · DMs and safety | M56 DM home, M57 verified DM, M58 key changed (blocking dialog), M59 key changed (notice line) | Re-layout; the logic exists |
| J · States, voice, search | M60 not pinned, M61 empty, M62 read only (Follow), M63 restricted, M64 voice not joined (Watch stream), M65 verify call, M66 search full screen, M67 inbox | M66 is the quick switcher full screen; M67 is the existing inbox (`components/inbox/`). M62 Follow is new (5.6) |

Order of work: rows A and B first (they are the chat core every other screen sits in), then C (needed to sign in on a phone at all), then D, E, G, H, I, J, and F last (the page editor on a phone is the largest piece).

### 5.5 Native hooks that the mocks need (added to Phases 2–3)
New bridge ops and IPlatformService members (both other hosts get a no-op or web implementation, contract §11 updated):
- `haptic(kind: 'light' | 'success' | 'warning')`: long press (M5), drag reorder (M3, tabs). iOS: `UIImpactFeedbackGenerator` / `UINotificationFeedbackGenerator`. Browser and Electron: no-op.
- `share({ url, text })`: invite links (M46). iOS: `UIActivityViewController`. Browser: `navigator.share` when present, else copy. Electron: null (the UI shows Copy only).
- `scanQr(): Promise<string | null>`: the Scan tab of M22. iOS: an AVFoundation (`AVCaptureMetadataOutput`, type `.qr`) full-screen scanner presented natively. Browser: the existing `BarcodeDetector` path in `components/security/qr-view.tsx`. Electron: null. This moves "native QR scan" out of the follow-up list.
- `setAppearance({ theme: 'dark' | 'light', tint })`: status bar style and the window background behind the safe areas follow the theme and the guild tint (M11/M12, M63). iOS: `overrideUserInterfaceStyle` + the root view background. Others: no-op.

### 5.6 Features the mocks show that do not exist yet (separate PRs, not part of the iOS host)
These are product features, not port work. Each needs server and contract work of its own, and the mobile screens hide them until they land:
- **Push notifications** (M33: per-kind push, lock-screen previews hidden by default, quiet hours, guild overrides). Needs APNs, a push registration route and E2EE-safe payloads (no plaintext in the push; the app decrypts in a Notification Service Extension). Largest item.
- **Privacy and safety settings** (M34): who can DM you, read receipts, typing and status visibility. Read receipts and DM policy do not exist.
- **Page features** (M41, M42): history, comments, lock, export, a 30-day trash and templates.
- **Channel follow** (M62).

Nothing in 5.6 blocks the TestFlight alpha.

## Phase 6: TestFlight alpha

### One-time setup (user, Apple side)
1. Enroll in the Apple Developer Program (organization account if it ships under a company). Note the Team ID.
2. In Certificates, Identifiers & Profiles, register the App ID with the final bundle id (for example `app.hachiman.ios`). No special capabilities for the alpha (push and associated domains come later).
3. In App Store Connect, go to My Apps → + → New App: iOS, name "Hachiman", the bundle id, SKU, primary language.
4. In App Store Connect → Users and Access → Integrations → App Store Connect API, create a key with the App Manager role. Download the `.p8` once, and note the Key ID and Issuer ID (for CI uploads).
5. Export compliance: the app uses encryption (AES-GCM, X25519, Ed25519, MLS; all standard algorithms, no proprietary crypto). Set `ITSAppUsesNonExemptEncryption` in Info.plist from the answer to App Store Connect's export compliance questions. Standard-algorithm E2EE messaging usually takes the "standard encryption" path, which in the US can require an annual self-classification report to BIS. Confirm this before the first external build.
6. TestFlight → Test Information: beta description, feedback email, and a privacy policy URL (needed for external testers).

### Each alpha build
- **Locally:**
  1. `pnpm -F @hachiman/hachiman-ios build` with `HACHIMAN_DOMAIN` endpoints (as `desktop.yml` sets `VITE_TAKUSEN_OIDC_ISSUER` and `VITE_HACHIMAN_GATEWAY_URL`).
  2. `xcodegen generate`.
  3. In Xcode, select Any iOS Device → Product → Archive → Distribute App → TestFlight & App Store → Upload.
- **CI (`.github/workflows/ios.yml`, mirrors `desktop.yml`):**
  - `workflow_dispatch` + pushes to `main` touching `apps/hachiman/**`, `apps/hachiman-ios/**`, `pkgs/**`, the lockfile; `macos-latest`.
  - Steps:
    1. Check `HACHIMAN_DOMAIN`.
    2. pnpm install.
    3. Web build.
    4. `brew install xcodegen && xcodegen`.
    5. `xcodebuild archive` with `CURRENT_PROJECT_VERSION=${{ github.run_number }}`, `-allowProvisioningUpdates` and API-key auth (`-authenticationKeyPath/-authenticationKeyID/-authenticationKeyIssuerID`), so automatic signing creates the certificate and profile.
    6. `xcodebuild -exportArchive -exportOptionsPlist ExportOptions.plist` (`method: app-store-connect`, `destination: upload`).
  - Secrets: `ASC_KEY_P8` (base64), `ASC_KEY_ID`, `ASC_ISSUER_ID`. Variable: `APPLE_TEAM_ID`.
- **Testers:**
  - Internal (up to 100 App Store Connect users): the build is available after processing, with no review.
  - External (up to 10,000, by email or public link): add a group. The first build of each version needs Beta App Review.
  - Builds expire after 90 days.
- **Server side for testers:** nothing new. The origin `hachiman://app` and the redirect `app.hachiman://oauth-callback` are already allowed. If the production `TAKUSEN_ALLOWED_ORIGINS` or `HACHIMAN_CLIENT_REDIRECT_URIS` override the defaults, they must contain these two values (seed `apps/takusen/src/db/seed.ts`).

## Verification
- **Phase 1 probe:** every hard requirement reports OK on the iOS 17 simulator, the iOS 18 simulator and one device.
- **Unit tests:**
  - XCTest (`xcodebuild test`): the scheme handler rejects `..`, encoded traversal and paths outside `WebApp/`; WrapKeyStore creates once and returns the same bytes; the bridge rejects a non-main-frame or foreign-origin message.
  - JS: `node --test` for the iOS PlatformService (event buffering, OAuth callback forwarding), as `apps/hachiman-browser` tests.
- **Existing suites** after Phase 4: shared UI vitest, client vitest, crypto vitest (codec spec and fuzz with `ios`), Takusen tests, `go test ./...`; tsgo typecheck of every package.
- **End-to-end in the simulator against `pnpm dev`** (Takusen :3000, gateway :8080):
  1. Sign in through ASWebAuthenticationSession.
  2. First device setup, or link from the desktop with Compare emoji (the iPhone as the new device).
  3. Send and decrypt messages.
  4. Open a pages channel.
  5. Join voice with the desktop app and hear both ways (SFrame), on a physical device for the mic.
  6. Kill and restart the app: the crypto store opens (Keychain wrap key + persistent IndexedDB).
  7. A `takusen://invite/...` link opens the app and joins.
- **TestFlight:** the CI upload succeeds, an internal tester installs and repeats the flow above against production.

## Out of scope (follow-ups)
- Android.
- Screen share (ReplayKit broadcast extension).
- Push notifications (APNs + server work).
- CallKit / background voice.
- Universal links (AASA file).
- iPad layout.
- The native region probe.
- The new product features of Phase 5.6 (push, privacy settings, page history/trash/templates, channel follow).
- App Store (non-TestFlight) release.
