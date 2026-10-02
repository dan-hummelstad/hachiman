import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  safeStorage,
  systemPreferences,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import {
  OPEN_EXTERNAL_CHANNEL,
  PROBE_REGIONS_CHANNEL,
  SECURE_STORAGE_CLEAR_CHANNEL,
  SECURE_STORAGE_GET_CHANNEL,
} from "../shared/ipc";
import { buildCsp } from "./csp";
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

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    // Dark `--background` (docs/ui-redesign.md §2, matches the HTML pre-paint) so there is no flash or seam.
    backgroundColor: "#22252c",
    // macOS: content runs under the title bar; the renderer's 28px <WindowStrip />
    // is the drag region and the traffic lights are centred in it. Win/Linux keep
    // the native frame.
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 12, y: 8 },
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

  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
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
function checkAppFrame(e: IpcMainInvokeEvent): void {
  const frame = e.senderFrame;
  if (!frame || frame.parent !== null || !renderer.isAppUrl(frame.url)) {
    throw new SecureStorageError("Malformed", "caller is not the app page");
  }
}
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

  renderer.serve(CSP);

  registerScreenShare((url) => renderer.isAppUrl(url));

  createWindow();

  app.on("activate", function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
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
