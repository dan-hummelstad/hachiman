/**
 * Custom-scheme deep links → renderer IPC.
 *
 *  - `takusen://invite/<code>`         → INVITE_CODE_CHANNEL (payload: the code)
 *  - `app.hachiman://oauth-callback?…` → OAUTH_CALLBACK_CHANNEL (payload: the raw URL;
 *    the shared UI's oracleService parses code/state). Reverse-DNS scheme because
 *    RFC 8252 §7.1 requires it for native OAuth redirects (panva rejects bare schemes).
 *
 * Entry points: cold-start argv (Win/Linux), `second-instance` argv (Win/Linux,
 * app already running), `open-url` (macOS, both cases). The single-instance lock
 * is what makes the Win/Linux hand-off reach the running window at all.
 */
import { BrowserWindow, type App } from "electron";
import path from "path";
import { INVITE_CODE_CHANNEL, OAUTH_CALLBACK_CHANNEL } from "../shared/ipc";

const INVITE_SCHEME = "takusen";
const OAUTH_SCHEME = "app.hachiman";
// Same shape as the shared UI's parseInviteCode (apps/hachiman/src/services/InviteService.ts),
// which main can't import; keep the two in step.
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{2,64}$/;

type Delivery = { channel: string; payload: string };

/** Map a raw URL to what the renderer receives, or null if it isn't ours. */
function route(raw: string): Delivery | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === `${INVITE_SCHEME}:` && url.hostname === "invite") {
    const code = url.pathname.replace(/^\/+|\/+$/g, "");
    return INVITE_CODE_RE.test(code)
      ? { channel: INVITE_CODE_CHANNEL, payload: code }
      : null;
  }
  if (
    url.protocol === `${OAUTH_SCHEME}:` &&
    url.hostname === "oauth-callback"
  ) {
    return { channel: OAUTH_CALLBACK_CHANNEL, payload: raw };
  }
  return null;
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
    if (win.isMinimized()) win.restore();
    win.focus();
    win.webContents.send(d.channel, d.payload);
  };

  electronApp.on("second-instance", (_event, argv) => argv.forEach(dispatch));
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
