// Shared UI ↔ host seam. Contract: docs/gateway-protocol.md §11.

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

export interface IPlatformService {
  readonly platform: 'electron' | 'browser'
  /** The host hides the native title bar, so the UI draws a draggable strip (Electron on macOS). */
  readonly insetTitleBar: boolean
  /** OAuth `redirect_uri` for this host; Oracle's client registration must allow it. */
  readonly oauthRedirectUri: string
  /** Send the user to the OAuth authorization page. Browser: same-tab redirect. Electron: system browser. */
  beginOAuth(url: string): void
  /** Invite links (`takusen://invite/<code>` or `https://<oracle>/invite/<code>`) → code. Returns unsubscribe. */
  onInviteCode(cb: (code: string) => void): () => void
  /** OAuth redirect URLs delivered by the host (Electron custom scheme / browser callback route). */
  onOAuthCallback(cb: (url: string) => void): () => void
  /** Electron: TCP-connect RTT probe from main. Browser: resolves []. */
  probeRegions(targets: RegionProbeTarget[]): Promise<RegionProbeResult[]>
  /** Electron: screens and windows for the in-app share picker. Browser: null (it has its own picker). */
  getScreenSources(): Promise<ScreenSource[] | null>
  /** Electron: the listed source that the next screen share captures. Browser: no-op. */
  selectScreenSource(id: string): Promise<void>
}
