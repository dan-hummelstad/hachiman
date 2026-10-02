import { contextBridge, ipcRenderer } from "electron";
import {
  INVITE_CODE_CHANNEL,
  OAUTH_CALLBACK_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PROBE_REGIONS_CHANNEL,
  SCREEN_SOURCES_CHANNEL,
  SELECT_SCREEN_SOURCE_CHANNEL,
  type ScreenSourceInfo,
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
  /** `takusen://invite/<code>` deep links → code. Returns unsubscribe. */
  onInviteCode: bufferedChannel(INVITE_CODE_CHANNEL),
  /** Raw `app.hachiman://oauth-callback?…` URLs. Returns unsubscribe. */
  onOAuthCallback: bufferedChannel(OAUTH_CALLBACK_CHANNEL),
  /** TCP-connect RTT probe run in main (targets validated there). */
  probeRegions: (
    targets: { region: string; host: string; port: number }[],
  ): Promise<{ region: string; rttMs: number | null }[]> =>
    ipcRenderer.invoke(PROBE_REGIONS_CHANNEL, targets),
  getScreenSources: (): Promise<ScreenSourceInfo[]> =>
    ipcRenderer.invoke(SCREEN_SOURCES_CHANNEL),
  /** The listed source that the next getDisplayMedia captures. */
  selectScreenSource: (id: string): Promise<void> =>
    ipcRenderer.invoke(SELECT_SCREEN_SOURCE_CHANNEL, id),
};

export type HachimanBridge = typeof bridge;

contextBridge.exposeInMainWorld("hachiman", bridge);
