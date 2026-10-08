import {
  app,
  shell,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  safeStorage,
  systemPreferences,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import {
  CHECK_FOR_UPDATE_CHANNEL,
  CLOSE_TO_TRAY_GET_CHANNEL,
  CLOSE_TO_TRAY_SET_CHANNEL,
  GLOBAL_SHORTCUT_CHANNEL,
  OPEN_EXTERNAL_CHANNEL,
  PROBE_REGIONS_CHANNEL,
  SECURE_STORAGE_CLEAR_CHANNEL,
  SECURE_STORAGE_GET_CHANNEL,
  SET_GLOBAL_SHORTCUTS_CHANNEL,
} from "../shared/ipc";
import { createAppPrefsStore, type AppPrefsStore } from "./app-prefs";
import { buildCsp } from "./csp";
import { createGlobalShortcuts } from "./global-shortcuts";
import {
  createWrapKeyStore,
  SecureStorageError,
  toIpcResult,
  type WrapKeyStore,
} from "./secure-storage";
import { flushPendingUrls, registerProtocolHandlers } from "./protocol-handler";
import { validateProbeTargets } from "./probe-target-guard";
import { probeRegions } from "./region-probe";
import { registerScreenShare } from "./screen-share";
import { createTray, revealWindow } from "./tray";
import { checkForUpdate, startUpdater } from "./updater";
import {
  devRenderer,
  packagedRenderer,
  registerRendererScheme,
} from "./renderer-protocol";

// Pick the renderer source once: electron-vite's dev server, or the built
// renderer served from hachiman://app (packaged and `electron-vite preview`).
const devServerUrl = is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
const renderer = devServerUrl
  ? devRenderer(devServerUrl)
  : packagedRenderer(join(__dirname, "../renderer"));
const CSP = buildCsp({ ...import.meta.env }, { devServerUrl });

/** Opens an http(s) URL in the system browser. Throws for any other scheme. */
async function openExternalHttp(raw: unknown): Promise<void> {
  const u = new URL(String(raw));
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`refused to open URL with protocol ${u.protocol}`);
  }
  await shell.openExternal(u.toString());
}

// Module-scoped so the protocol handler can dispatch deep links once a window
// exists. The single-instance lock guarantees at most one main window.
let mainWindowRef: BrowserWindow | null = null;

// Set by Cmd+Q, the tray "Quit", the updater's app.quit() and every other real
// quit, so that the close handler lets the window close.
let quitting = false;
app.on("before-quit", () => {
  quitting = true;
});

// Read on first use: a window close or an IPC call, both after app.whenReady.
let appPrefs: AppPrefsStore | null = null;
function prefs(): AppPrefsStore {
  appPrefs ??= createAppPrefsStore(app.getPath("userData"));
  return appPrefs;
}

/** Tray "Open Hachiman": show the hidden window, or make one when it was closed. */
function openMainWindow(): void {
  if (mainWindowRef) revealWindow(mainWindowRef);
  else createWindow();
}

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Dark `--surface-window` (docs/ui-redesign.md §2) so there is no flash or seam.
    backgroundColor: "#0e0f15",
    // macOS: content runs under the title bar. The traffic lights sit in the sidebar's
    // 40px controls row, and the tab row above the content card is the drag region
    // (arc-redesign-plan decision 9). Win/Linux keep the native frame.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      // Preload only uses contextBridge/ipcRenderer, so the renderer can be fully sandboxed.
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindowRef = mainWindow;

  // Close button with close-to-tray on: hide and keep running (./tray.ts shows it again).
  mainWindow.on("close", (event) => {
    if (quitting || !prefs().get().closeToTray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
    // macOS keeps the app without a window: nothing would receive the keys.
    globalShortcuts.clear();
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    // Replay deep links that arrived before the renderer existed.
    flushPendingUrls(mainWindow);
  });

  // window.open / target=_blank → system browser, http(s) only.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    openExternalHttp(details.url).catch((e: unknown) =>
      console.warn("[hachiman] window.open rejected", e),
    );
    return { action: "deny" };
  });

  // The renderer has no client-side routes, so any top-level navigation away
  // from the app's own pages is unexpected (e.g. a dropped link): block it.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!renderer.isAppUrl(url)) event.preventDefault();
  });

  void mainWindow.loadURL(renderer.indexUrl);
}

// Privileged-scheme registration must precede `app.whenReady`.
registerRendererScheme();

// Must run before `app.whenReady`: a second instance hands its URL to us and quits.
if (!registerProtocolHandlers(app, () => mainWindowRef)) app.quit();

// IPC: TCP connect-time RTT probe (raw `net` sockets exist only in main). The
// prober never throws (failures surface as `rttMs: null` per result).
//
// SECURITY: the payload is attacker-influenceable (renderer XSS reaches the
// preload bridge; targets come from the public/unauthed Takusen regions list).
// `validateProbeTargets` enforces host (no loopback / private / link-local /
// metadata, DNS-resolved), port (allowlist), count (≤ 64) and shape BEFORE any
// socket is opened, turning a would-be SSRF / internal-port-scan primitive into
// a narrow region prober. See ./probe-target-guard.ts.
ipcMain.handle(PROBE_REGIONS_CHANNEL, async (_e, targets: unknown) => {
  try {
    const safe = await validateProbeTargets(targets);
    return await probeRegions(safe);
  } catch (e) {
    console.warn("[hachiman] probe-regions rejected", e);
    return [];
  }
});

// IPC: renderer asks main to open the system browser for the OAuth authorize URL.
ipcMain.handle(OPEN_EXTERNAL_CHANNEL, async (_e, url: unknown) => {
  // Only http/https, so the renderer can't turn this into a generic URL/file opener.
  try {
    await openExternalHttp(url);
  } catch (e) {
    console.warn("[hachiman] open-external rejected", e);
    throw e;
  }
});

// IPC: the crypto store wrap key (§11 secureStorage). Only the top frame of the
// app page may ask. The handlers return data, never throw (see toIpcResult).
let wrapKeys: WrapKeyStore | null = null;
function wrapKeyStore(): WrapKeyStore {
  wrapKeys ??= createWrapKeyStore({
    dir: join(app.getPath("userData"), "keys"),
    safeStorage,
    platform: process.platform,
  });
  return wrapKeys;
}
function isAppFrame(e: IpcMainInvokeEvent): boolean {
  const frame = e.senderFrame;
  return (
    frame !== null && frame.parent === null && renderer.isAppUrl(frame.url)
  );
}
function checkAppFrame(e: IpcMainInvokeEvent): void {
  if (!isAppFrame(e))
    throw new SecureStorageError("Malformed", "caller is not the app page");
}
// IPC: the settings "Check for updates" button. A manual check offers a build put off with "Later" again.
ipcMain.handle(CHECK_FOR_UPDATE_CHANNEL, (e) =>
  isAppFrame(e)
    ? checkForUpdate(true)
    : { status: "failed", reason: "caller is not the app page" },
);
// IPC: the "Close button minimises to tray" switch in user settings.
ipcMain.handle(CLOSE_TO_TRAY_GET_CHANNEL, (e) => {
  checkAppFrame(e);
  return prefs().get().closeToTray;
});
ipcMain.handle(CLOSE_TO_TRAY_SET_CHANNEL, async (e, on: unknown) => {
  checkAppFrame(e);
  if (typeof on !== "boolean") throw new Error("closeToTray must be a boolean");
  await prefs().set({ closeToTray: on });
});
ipcMain.handle(SECURE_STORAGE_GET_CHANNEL, (e, userId: unknown) =>
  toIpcResult(async () => {
    checkAppFrame(e);
    return wrapKeyStore().getWrapKeyBytes(userId);
  }),
);
ipcMain.handle(SECURE_STORAGE_CLEAR_CHANNEL, (e, userId: unknown) =>
  toIpcResult(async () => {
    checkAppFrame(e);
    await wrapKeyStore().clear(userId);
  }),
);

// IPC: the keybinds that work while the app is in the background (mute,
// deafen). Only the app page may set them; the payload is checked in
// ./global-shortcuts.ts. A fired shortcut goes to the main window.
const globalShortcuts = createGlobalShortcuts(globalShortcut, (action) =>
  mainWindowRef?.webContents.send(GLOBAL_SHORTCUT_CHANNEL, action),
);
ipcMain.handle(SET_GLOBAL_SHORTCUTS_CHANNEL, (e, shortcuts: unknown) => {
  if (!isAppFrame(e)) throw new Error("caller is not the app page");
  return globalShortcuts.set(shortcuts);
});
app.on("will-quit", () => globalShortcuts.clear());

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId("com.electron");

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  // macOS requires explicit microphone permission via TCC. Other platforms
  // handle this at the OS / browser layer and have no Electron-level prompt.
  void ensureMicrophoneAccess();
  // The camera is not requested here: only the QR scan uses it, and its getUserMedia call
  // shows the OS prompt on first use. A denial shows the paste field (qr-view.tsx ScanOrPaste).

  renderer.serve(CSP);

  registerScreenShare((url) => renderer.isAppUrl(url));

  createWindow();
  createTray(openMainWindow);

  startUpdater();

  app.on("activate", function () {
    // macOS dock click: show the window that close-to-tray hid, or make a new one
    // when it was closed. A window that is still loading shows itself (ready-to-show).
    if (!mainWindowRef) createWindow();
    else if (!mainWindowRef.webContents.isLoading())
      revealWindow(mainWindowRef);
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

async function ensureMicrophoneAccess(): Promise<void> {
  if (process.platform !== "darwin") return;

  const status = systemPreferences.getMediaAccessStatus("microphone");
  if (status === "granted") return;

  if (status === "denied" || status === "restricted") {
    // The OS dialog cannot reopen once denied/restricted — the user has to
    // flip the toggle in System Settings → Privacy & Security → Microphone.
    console.warn(
      `[hachiman] Microphone access is "${status}". Voice will not work until enabled in System Settings → Privacy & Security → Microphone.`,
    );
    return;
  }

  // status === 'not-determined' — show the OS prompt.
  const granted = await systemPreferences.askForMediaAccess("microphone");
  if (!granted) {
    console.warn(
      "[hachiman] User denied microphone access. Re-enable in System Settings → Privacy & Security → Microphone.",
    );
  }
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
