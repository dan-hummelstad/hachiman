import { contextBridge, ipcRenderer } from "electron";
import {
  CHECK_FOR_UPDATE_CHANNEL,
  CLOSE_TO_TRAY_GET_CHANNEL,
  CLOSE_TO_TRAY_SET_CHANNEL,
  GLOBAL_SHORTCUT_CHANNEL,
  INVITE_LINK_CHANNEL,
  OAUTH_CALLBACK_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PROBE_REGIONS_CHANNEL,
  SCREEN_SOURCES_CHANNEL,
  SECURE_STORAGE_CLEAR_CHANNEL,
  SECURE_STORAGE_GET_CHANNEL,
  SELECT_SCREEN_SOURCE_CHANNEL,
  SET_GLOBAL_SHORTCUTS_CHANNEL,
  type GlobalShortcutInfo,
  type ScreenSourceInfo,
  type SecureStorageResult,
  type UpdateCheckResult,
} from "../shared/ipc";

/**
 * Deep links can arrive before React mounts and subscribes. Listen from preload
 * load (before any page script) and buffer until the first subscriber appears,
 * so a cold-start invite / OAuth redirect is never dropped.
 */
function bufferedChannel(channel: string) {
  const subs = new Set<(value: string) => void>();
  const pending: string[] = [];
  ipcRenderer.on(channel, (_e, value: unknown) => {
    if (typeof value !== "string") return;
    if (subs.size === 0) pending.push(value);
    else subs.forEach((cb) => cb(value));
  });
  return (cb: (value: string) => void): (() => void) => {
    subs.add(cb);
    pending.splice(0).forEach((v) => cb(v));
    return () => void subs.delete(cb);
  };
}

// The ONLY surface the renderer sees (contextIsolation + sandbox), as `window.hachiman`
// (typed for the renderer by ./window.d.ts).
const bridge = {
  /** True where main hides the native title bar (macOS). */
  insetTitleBar: process.platform === "darwin",
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  /**
   * `takusen://invite/<code>[#k=<key>]` deep links, as the link that main checked
   * and rebuilt. The key is the secret of an invite with history. Returns unsubscribe.
   */
  onInviteLink: bufferedChannel(INVITE_LINK_CHANNEL),
  /** Raw `app.hachiman://oauth-callback?…` URLs. Returns unsubscribe. */
  onOAuthCallback: bufferedChannel(OAUTH_CALLBACK_CHANNEL),
  /** TCP-connect RTT probe run in main (targets validated there). */
  probeRegions: (
    targets: { region: string; host: string; port: number }[],
  ): Promise<{ region: string; rttMs: number | null }[]> =>
    ipcRenderer.invoke(PROBE_REGIONS_CHANNEL, targets),
  getScreenSources: (): Promise<ScreenSourceInfo[]> =>
    ipcRenderer.invoke(SCREEN_SOURCES_CHANNEL),
  /** The listed source that the next getDisplayMedia captures, with system audio when `audio`. */
  selectScreenSource: (id: string, audio: boolean): Promise<void> =>
    ipcRenderer.invoke(SELECT_SCREEN_SOURCE_CHANNEL, id, audio),
  /** Main captures system audio with a share here (loopback, main/screen-share.ts). */
  screenShareAudio: process.platform === "win32",
  /** Check for a desktop update now; main shows its restart prompt for a new build. */
  checkForUpdate: (): Promise<UpdateCheckResult> =>
    ipcRenderer.invoke(CHECK_FOR_UPDATE_CHANNEL),
  /** The close button hides the window to the tray (main/app-prefs.ts keeps the value). */
  closeToTray: {
    get: (): Promise<boolean> => ipcRenderer.invoke(CLOSE_TO_TRAY_GET_CHANNEL),
    set: (on: boolean): Promise<void> =>
      ipcRenderer.invoke(CLOSE_TO_TRAY_SET_CHANNEL, on),
  },
  /** Register OS-wide shortcuts in place of the previous set; resolves with the refused actions. */
  setGlobalShortcuts: (shortcuts: GlobalShortcutInfo[]): Promise<string[]> =>
    ipcRenderer.invoke(SET_GLOBAL_SHORTCUTS_CHANNEL, shortcuts),
  /** A global shortcut fired, with its action. Not buffered: a press before the UI listens is moot. */
  onGlobalShortcut: (cb: (action: string) => void): (() => void) => {
    const listener = (_e: unknown, action: unknown): void => {
      if (typeof action === "string") cb(action);
    };
    ipcRenderer.on(GLOBAL_SHORTCUT_CHANNEL, listener);
    return () =>
      void ipcRenderer.removeListener(GLOBAL_SHORTCUT_CHANNEL, listener);
  },
  /** Wrap key of the crypto store (main validates the userId). The caller zeroes `value`. */
  secureStorage: {
    getWrapKeyBytes: (
      userId: string,
    ): Promise<SecureStorageResult<Uint8Array<ArrayBuffer>>> =>
      ipcRenderer.invoke(SECURE_STORAGE_GET_CHANNEL, userId),
    clear: (userId: string): Promise<SecureStorageResult<void>> =>
      ipcRenderer.invoke(SECURE_STORAGE_CLEAR_CHANNEL, userId),
  },
};

export type HachimanBridge = typeof bridge;

contextBridge.exposeInMainWorld("hachiman", bridge);
