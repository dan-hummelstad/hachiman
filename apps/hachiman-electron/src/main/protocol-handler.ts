/**
 * Custom-scheme deep links → renderer IPC. ./deep-link-route.ts checks each URL:
 *
 *  - `takusen://invite/<code>[#k=<key>]` → INVITE_LINK_CHANNEL (payload: the
 *    checked link, rebuilt)
 *  - `app.hachiman://oauth-callback?…`   → OAUTH_CALLBACK_CHANNEL (payload: the raw URL)
 *
 * Entry points: cold-start argv (Win/Linux), `second-instance` argv (Win/Linux,
 * app already running), `open-url` (macOS, both cases). The single-instance lock
 * is what makes the Win/Linux hand-off reach the running window at all.
 */
import { BrowserWindow, type App } from "electron";
import path from "path";
import { INVITE_LINK_CHANNEL, OAUTH_CALLBACK_CHANNEL } from "../shared/ipc";
import { INVITE_SCHEME, OAUTH_SCHEME, routeDeepLink } from "./deep-link-route";
import { revealWindow } from "./tray";

type Delivery = { channel: string; payload: string };

const CHANNELS = {
  invite: INVITE_LINK_CHANNEL,
  oauth: OAUTH_CALLBACK_CHANNEL,
} as const;

/** Map a raw URL to what the renderer receives, or null if it isn't ours. */
function route(raw: string): Delivery | null {
  const link = routeDeepLink(raw);
  return link ? { channel: CHANNELS[link.kind], payload: link.payload } : null;
}

// Deliveries that arrived before a window existed; drained by flushPendingUrls.
const pending: Delivery[] = [];

/**
 * Must run BEFORE `app.whenReady` so the single-instance lock precedes any window.
 * Returns false if this is the second instance — the caller must quit so the
 * running instance handles the URL.
 */
export function registerProtocolHandlers(
  electronApp: App,
  getMainWindow: () => BrowserWindow | null,
): boolean {
  setAsDefaultClient(electronApp, INVITE_SCHEME);
  setAsDefaultClient(electronApp, OAUTH_SCHEME);
  if (!electronApp.requestSingleInstanceLock()) return false;

  const dispatch = (raw: string): void => {
    const d = route(raw);
    if (!d) return;
    const win = getMainWindow();
    if (!win) {
      pending.push(d);
      return;
    }
    revealWindow(win);
    win.webContents.send(d.channel, d.payload);
  };

  // A second launch, with or without a link, shows the window (also one hidden to the tray).
  electronApp.on("second-instance", (_event, argv) => {
    const win = getMainWindow();
    if (win) revealWindow(win);
    argv.forEach(dispatch);
  });
  electronApp.on("open-url", (event, url) => {
    event.preventDefault();
    dispatch(url);
  });
  for (const arg of process.argv) {
    const d = route(arg);
    if (d) pending.push(d);
  }
  return true;
}

/**
 * Replay buffered deep links once the window is shown. The preload registers its
 * IPC listeners before any page script runs and buffers until the UI subscribes,
 * so no delay is needed here.
 */
export function flushPendingUrls(win: BrowserWindow): void {
  for (const d of pending.splice(0)) win.webContents.send(d.channel, d.payload);
}

/**
 * In dev (`electron-vite dev`) the running binary is plain electron, so the OS
 * registration must point back at it with the entry script or clicking a link
 * launches an empty default app.
 */
function setAsDefaultClient(electronApp: App, scheme: string): void {
  if (!process.defaultApp) electronApp.setAsDefaultProtocolClient(scheme);
  else if (process.argv.length >= 2)
    electronApp.setAsDefaultProtocolClient(scheme, process.execPath, [
      path.resolve(process.argv[1]!),
    ]);
}
