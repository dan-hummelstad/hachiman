// IPC channel names shared by main (index.ts, protocol-handler.ts) and the preload.
// Constants only: electron-vite inlines this module into each bundle, so the
// sandboxed preload never loads a main-process module at runtime.

/**
 * main → renderer: `takusen://invite/<code>[#k=<key>]` deep link; payload is the
 * link that main checked and rebuilt (main/deep-link-route.ts). The renderer
 * parses it with the shared UI's parseInviteLink.
 */
export const INVITE_LINK_CHANNEL = "hachiman:invite-link";
/** main → renderer: `app.hachiman://oauth-callback?…`; payload is the raw URL. */
export const OAUTH_CALLBACK_CHANNEL = "hachiman:oauth-callback";
/** renderer → main (invoke): open an http(s) URL in the system browser. */
export const OPEN_EXTERNAL_CHANNEL = "hachiman:open-external";
/** renderer → main (invoke): TCP-connect RTT probe of region endpoints. */
export const PROBE_REGIONS_CHANNEL = "hachiman:probe-regions";
/**
 * renderer → main (invoke, url, maxBytes): one https GET for a link preview
 * (main/link-fetch.ts). Resolves `LinkResourceInfo | null`.
 */
export const FETCH_LINK_CHANNEL = "hachiman:fetch-link";
/** Same shape as `LinkResource` in `@hachiman/hachiman` (IPlatformService.ts). */
export interface LinkResourceInfo {
  url: string;
  contentType: string;
  body: Uint8Array<ArrayBuffer>;
}
/** renderer → main (invoke): list screens and windows for the share picker. */
export const SCREEN_SOURCES_CHANNEL = "hachiman:screen-sources";
/** renderer → main (invoke, id, audio): the listed source that the next getDisplayMedia captures, and whether with system audio. */
export const SELECT_SCREEN_SOURCE_CHANNEL = "hachiman:select-screen-source";
/** Whether main captures system audio with a screen share (loopback is Windows only, main/screen-share.ts). */
export function screenShareAudioSupported(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/** renderer → main (invoke): check for a desktop update now (updater.ts). */
export const CHECK_FOR_UPDATE_CHANNEL = "hachiman:check-for-update";

/** renderer → main (invoke): the close-to-tray setting (main/app-prefs.ts). Returns a boolean. */
export const CLOSE_TO_TRAY_GET_CHANNEL = "hachiman:close-to-tray-get";
/** renderer → main (invoke): set the close-to-tray setting; payload is a boolean. */
export const CLOSE_TO_TRAY_SET_CHANNEL = "hachiman:close-to-tray-set";
/**
 * renderer → main (invoke): register these global shortcuts in place of the
 * previous set (main/global-shortcuts.ts). Payload `GlobalShortcutInfo[]`;
 * the result lists the actions that the OS refused.
 */
export const SET_GLOBAL_SHORTCUTS_CHANNEL = "hachiman:set-global-shortcuts";
/** main → renderer: a global shortcut fired; payload is its action. */
export const GLOBAL_SHORTCUT_CHANNEL = "hachiman:global-shortcut";

/** Same shape as `GlobalShortcut` in `@hachiman/hachiman` (IPlatformService.ts). */
export interface GlobalShortcutInfo {
  action: string;
  accelerator: string;
}

/** Same shape as `UpdateCheckResult` in `@hachiman/hachiman` (IPlatformService.ts). */
export type UpdateCheckResult =
  | { status: "up-to-date"; build: string }
  | { status: "offered"; build: string; latest: string }
  | { status: "not-available"; reason: string }
  | { status: "failed"; reason: string };

/** One share target for the in-app picker (SCREEN_SOURCES_CHANNEL). */
export interface ScreenSourceInfo {
  id: string;
  name: string;
  kind: "screen" | "window";
  /** JPEG data URL. */
  thumbnail: string;
}

/** renderer → main (invoke): the 32 wrap key bytes of a user, made on the first call (§11). */
export const SECURE_STORAGE_GET_CHANNEL = "hachiman:secure-storage-get";
/** renderer → main (invoke): delete the wrap key of a user. */
export const SECURE_STORAGE_CLEAR_CHANNEL = "hachiman:secure-storage-clear";

/** Same values as `SecureStorageErrorCode` in `@hachiman/hachiman` (IPlatformService.ts). */
export type SecureStorageFailureCode =
  "SecureStorageUnavailable" | "StoreCorrupt" | "Malformed";

/**
 * IPC result of the secure storage channels. An Error thrown in an ipcMain
 * handler reaches the renderer as a message only, so main sends the code as data.
 */
export type SecureStorageResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: SecureStorageFailureCode; message: string };
