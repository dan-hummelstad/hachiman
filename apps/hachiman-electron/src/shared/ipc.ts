// IPC channel names shared by main (index.ts, protocol-handler.ts) and the preload.
// Constants only: electron-vite inlines this module into each bundle, so the
// sandboxed preload never loads a main-process module at runtime.

/** main → renderer: `takusen://invite/<code>` deep link; payload is the code. */
export const INVITE_CODE_CHANNEL = "hachiman:invite-code";
/** main → renderer: `app.hachiman://oauth-callback?…`; payload is the raw URL. */
export const OAUTH_CALLBACK_CHANNEL = "hachiman:oauth-callback";
/** renderer → main (invoke): open an http(s) URL in the system browser. */
export const OPEN_EXTERNAL_CHANNEL = "hachiman:open-external";
/** renderer → main (invoke): TCP-connect RTT probe of region endpoints. */
export const PROBE_REGIONS_CHANNEL = "hachiman:probe-regions";
/** renderer → main (invoke): list screens and windows for the share picker. */
export const SCREEN_SOURCES_CHANNEL = "hachiman:screen-sources";
/** renderer → main (invoke): the listed source that the next getDisplayMedia captures. */
export const SELECT_SCREEN_SOURCE_CHANNEL = "hachiman:select-screen-source";

/** One share target for the in-app picker (SCREEN_SOURCES_CHANNEL). */
export interface ScreenSourceInfo {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** JPEG data URL. */
  thumbnail: string;
}
