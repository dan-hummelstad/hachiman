import { app, shell, BrowserWindow, ipcMain, systemPreferences } from "electron";
import { join } from "path";
import { URL as NodeURL } from "url";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import {
  probeRegionsRtt,
  type RegionProbeTarget,
} from "@hachiman/hachiman-node";
import icon from "../../resources/icon.png?asset";
import { flushPendingUrls, registerProtocolHandlers } from "./protocol-handler";

// Custom scheme for the Oracle/Takusen OAuth PKCE callback. Kept separate
// from agent D's `takusen://` deep-link scheme so the two flows are
// independently revokable.
// Reverse-DNS scheme — required by RFC 8252 §7.1 for native OAuth callback
// URIs (panva's oidc-provider rejects bare schemes like `hachiman://`).
const HACHIMAN_PROTOCOL = "app.hachiman";

// Module-scoped window ref so the protocol-handler can dispatch deep links
// once a window exists. The single-instance lock guarantees at most one main
// window across the whole app.
let mainWindowRef: BrowserWindow | null = null;

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  mainWindowRef = mainWindow;

  mainWindow.on("closed", () => {
    if (mainWindowRef === mainWindow) mainWindowRef = null;
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
    // Replay any takusen://… URLs that arrived before the renderer existed.
    flushPendingUrls(mainWindow);
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

/**
 * Parse `app.hachiman://oauth-callback?code=...&state=...` and forward to the
 * renderer via IPC. The renderer's main.tsx listens on the same channel.
 */
function handleHachimanProtocolUrl(rawUrl: string): void {
  try {
    const url = new NodeURL(rawUrl);
    if (url.protocol !== `${HACHIMAN_PROTOCOL}:`) return;
    if (url.hostname !== "oauth-callback" && !url.pathname.includes("oauth-callback")) return;
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) return;
    const target = mainWindowRef;
    if (!target) {
      console.warn("[hachiman] OAuth callback received before window was ready");
      return;
    }
    if (target.isMinimized()) target.restore();
    target.focus();
    target.webContents.send("hachiman:oauth-callback", { code, state });
  } catch (e) {
    console.warn("[hachiman] Failed to parse protocol URL", e);
  }
}

// Protocol handlers MUST be registered before `app.whenReady` resolves so
// the single-instance lock takes effect and OS-level URL events get caught.
// If we're the second instance, the existing instance will handle the URL —
// quit immediately.
const protocolReady = registerProtocolHandlers(app, {
  getMainWindow: () => mainWindowRef,
});
if (!protocolReady) {
  app.quit();
}

// Register the app.hachiman:// scheme alongside takusen://. We can't use
// `extraSchemeHandlers` because the OAuth callback needs URL parsing into
// a typed payload before reaching the renderer (the takusen flow forwards
// raw URLs). The single-instance lock from `registerProtocolHandlers` covers
// both schemes; we only need to add the parse-and-dispatch hooks here.
if (process.defaultApp && process.argv.length >= 2) {
  app.setAsDefaultProtocolClient(HACHIMAN_PROTOCOL, process.execPath, [
    join(process.argv[1] ?? ""),
  ]);
} else {
  app.setAsDefaultProtocolClient(HACHIMAN_PROTOCOL);
}

app.on("second-instance", (_event, argv) => {
  const url = argv.find((a) => a.startsWith(`${HACHIMAN_PROTOCOL}://`));
  if (url) handleHachimanProtocolUrl(url);
});

app.on("open-url", (event, url) => {
  if (url.startsWith(`${HACHIMAN_PROTOCOL}://`)) {
    event.preventDefault();
    handleHachimanProtocolUrl(url);
  }
});

// IPC: renderer asks main to measure client→region RTTs. The prober uses raw
// node `net` sockets (TCP connect-time RTT), which only exist in the main
// process — the renderer relays targets here and gets back the results. The
// prober never throws (failures surface as `rttMs: null` per result).
ipcMain.handle(
  "hachiman:probe-regions",
  (_e, targets: RegionProbeTarget[]) => probeRegionsRtt(targets),
);

// IPC: renderer asks main to open the system browser for the OAuth authorize URL.
ipcMain.handle("hachiman:open-external", async (_e, url: string) => {
  // Guard: only http/https; reject anything else to avoid becoming a generic
  // URL opener from the renderer process.
  try {
    const u = new NodeURL(url);
    if (!["http:", "https:"].includes(u.protocol)) {
      throw new Error(`refused to open URL with protocol ${u.protocol}`);
    }
    await shell.openExternal(url);
  } catch (e) {
    console.warn("[hachiman] open-external rejected", e);
    throw e;
  }
});

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

  // IPC test
  ipcMain.on("ping", () => console.log("pong"));

  // macOS requires explicit microphone permission via TCC. Other platforms
  // handle this at the OS / browser layer and have no Electron-level prompt.
  void ensureMicrophoneAccess();

  createWindow();

  // If the app was launched cold by the OS routing an app.hachiman:// URL, argv
  // carries it (Windows/Linux). macOS uses `open-url` separately above.
  const launchUrl = process.argv.find((a) => a.startsWith(`${HACHIMAN_PROTOCOL}://`));
  if (launchUrl) handleHachimanProtocolUrl(launchUrl);

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
