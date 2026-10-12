// Shared UI ↔ host seam. Contract: docs/gateway-protocol.md §11.

import type { InviteLink } from '../lib/invite-link'

export type { InviteLink }

export interface RegionProbeTarget {
  region: string
  host: string
  port: number
}

export interface RegionProbeResult {
  region: string
  rttMs: number | null
}

/** A screen or window that the in-app share picker offers. */
export interface ScreenSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  /** Image URL (Electron: a JPEG data URL). */
  thumbnail: string
}

/** A manual desktop update check (`IPlatformService.checkForUpdate`). `build`: the short commit. */
export type UpdateCheckResult =
  | { status: 'up-to-date'; build: string }
  /** A newer build is downloaded and the host showed its restart prompt. */
  | { status: 'offered'; build: string; latest: string }
  /** The host cannot update itself: a dev build, the web app, or no build is published. */
  | { status: 'not-available'; reason: string }
  | { status: 'failed'; reason: string }

/** One OS-wide shortcut (`IPlatformService.setGlobalShortcuts`). */
export interface GlobalShortcut {
  /** The UI's own name for the action; `onGlobalShortcut` gives it back. */
  action: string
  /** An Electron accelerator, e.g. `CommandOrControl+Shift+M`. */
  accelerator: string
}

/** A tap of the haptic engine (`IPlatformService.haptic`). */
export type HapticKind = 'light' | 'success' | 'warning'

/** What `IPlatformService.share` hands to the OS share sheet. */
export interface ShareContent {
  url: string
  text?: string
}

/** The app theme that the host window follows (`IPlatformService.setAppearance`). */
export interface Appearance {
  theme: 'dark' | 'light'
  /** A hex color (`#rrggbb` or `#rrggbbaa`, for example the value of `--surface-window`): the window background behind the safe areas. */
  background: string
}

export interface IPlatformService {
  readonly platform: 'electron' | 'browser' | 'ios'
  /** The host hides the native title bar: the traffic lights sit in the sidebar's controls row (Electron on macOS). */
  readonly insetTitleBar: boolean
  /** OAuth `redirect_uri` for this host; Takusen's client registration must allow it. */
  readonly oauthRedirectUri: string
  /** Send the user to the OAuth authorization page. Browser: same-tab redirect. Electron: system browser. iOS: ASWebAuthenticationSession. */
  beginOAuth(url: string): void
  /**
   * Invite links (`takusen://invite/<code>` or `https://<takusen>/invite/<code>`, with
   * `#k=<key>` for an invite with history) → code and key (`parseInviteLink`). The host drops a
   * link that does not parse, and removes the link from its address bar. Returns unsubscribe.
   */
  onInviteLink(cb: (link: InviteLink) => void): () => void
  /** OAuth redirect URLs delivered by the host (Electron custom scheme / browser callback route). */
  onOAuthCallback(cb: (url: string) => void): () => void
  /** Electron: TCP-connect RTT probe from main. Browser: resolves []. */
  probeRegions(targets: RegionProbeTarget[]): Promise<RegionProbeResult[]>
  /** Electron: screens and windows for the in-app share picker. Browser: null (it has its own picker). */
  getScreenSources(): Promise<ScreenSource[] | null>
  /**
   * Electron: the listed source that the next screen share captures, with the system audio when
   * `audio` and `screenShareAudio` are true. Browser: no-op.
   */
  selectScreenSource(id: string, audio: boolean): Promise<void>
  /**
   * The in-app share picker can capture system audio with the share (Electron on Windows). False
   * elsewhere: Electron then shares video only, and the browser picker offers audio itself.
   */
  readonly screenShareAudio: boolean
  /** Electron: check for a new build now, and offer it (also one that the user put off). Browser: not-available. */
  checkForUpdate(): Promise<UpdateCheckResult>
  /** Electron: the close button hides the window to the tray (default on); main keeps the value. Browser: null. */
  readonly closeToTray: ICloseToTray | null
  /**
   * Electron: registers `shortcuts` with the OS in place of the previous set ([] lets all go).
   * Resolves with the actions that the OS refused (another app holds the key). Browser: null.
   */
  setGlobalShortcuts(shortcuts: GlobalShortcut[]): Promise<string[] | null>
  /** Electron: a global shortcut fired, with its action. Browser: never. Returns unsubscribe. */
  onGlobalShortcut(cb: (action: string) => void): () => void
  /** iOS: a tap of the haptic engine. Electron and browser: no-op. */
  haptic(kind: HapticKind): void
  /**
   * The OS share sheet. Resolves true when the user shared, false when they cancelled.
   * iOS: the native sheet. Browser: `navigator.share` when present, else null. Electron: null.
   * Null: the host cannot share, and the UI offers Copy only.
   */
  readonly share: ((content: ShareContent) => Promise<boolean>) | null
  /**
   * iOS: a native full-screen QR scanner. Resolves with the text of the code, or null when the
   * user cancelled. Electron and browser: null (the UI scans with `BarcodeDetector` where present).
   */
  readonly scanQr: (() => Promise<string | null>) | null
  /**
   * iOS: saves a UTF-8 text file through the Files export sheet. `name` is a file name with no
   * path (for example `hachiman-recovery-key.txt`). Resolves true when the user saved the file,
   * false when they cancelled. Electron and browser: null (the UI downloads a blob).
   */
  readonly saveTextFile: ((name: string, text: string) => Promise<boolean>) | null
  /** iOS: the status bar style and the window background follow the app theme. Others: no-op. */
  setAppearance(appearance: Appearance): void
  /** The wrap key of the encrypted crypto store (§12.17). */
  readonly secureStorage: ISecureStorage
}

export interface ICloseToTray {
  get(): Promise<boolean>
  set(on: boolean): Promise<void>
}

/**
 * The `code` of an error that `ISecureStorage` rejects with. The values are `CryptoErrorCode`
 * values of `@hachiman/crypto`, so the UI handles them like crypto errors.
 */
export type SecureStorageErrorCode = 'SecureStorageUnavailable' | 'StoreCorrupt' | 'Malformed'

export interface ISecureStorage {
  /** iOS uses 'os-keychain' (the iOS Keychain). */
  readonly backend: 'os-keychain' | 'browser-indexeddb'
  /**
   * The store wrap key of this install and user: AES-GCM 256, non-extractable, usages encrypt/decrypt.
   * The host creates it on the first call. Rejects with SecureStorageUnavailable when no OS keystore exists.
   * The error is an `Error` whose `name` and `code` are a `SecureStorageErrorCode`.
   */
  getWrapKey(userId: string): Promise<CryptoKey>
  /** Deletes the wrap key. The store of that user becomes unreadable. */
  clear(userId: string): Promise<void>
}

/** The `code` of a rejection from `ISecureStorage`, or null for another error. */
export function secureStorageErrorCode(e: unknown): SecureStorageErrorCode | null {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
  return code === 'SecureStorageUnavailable' || code === 'StoreCorrupt' || code === 'Malformed'
    ? code
    : null
}
