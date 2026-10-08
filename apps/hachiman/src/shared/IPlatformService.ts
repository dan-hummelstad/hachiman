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

export interface IPlatformService {
  readonly platform: 'electron' | 'browser'
  /** The host hides the native title bar: the traffic lights sit in the sidebar's controls row (Electron on macOS). */
  readonly insetTitleBar: boolean
  /** OAuth `redirect_uri` for this host; Takusen's client registration must allow it. */
  readonly oauthRedirectUri: string
  /** Send the user to the OAuth authorization page. Browser: same-tab redirect. Electron: system browser. */
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
  /** Electron: the listed source that the next screen share captures. Browser: no-op. */
  selectScreenSource(id: string): Promise<void>
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
