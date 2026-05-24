/**
 * takusen:// custom-scheme protocol handler.
 *
 * Wires three OS-level deep-link entry points to a single dispatch into the
 * renderer:
 *
 *  1. App was launched FROM a takusen://… click:
 *     - Windows / Linux: the URL is the last argv element (process.argv).
 *     - macOS: an `app.open-url` event fires after `ready`.
 *  2. App was already running and the OS hands the URL to the running
 *     instance (Windows/Linux: a second process spawns; macOS: open-url).
 *
 * For (2) on Windows/Linux we need a single-instance lock — without it, a
 * fresh process opens for every click and the URL never reaches the running
 * window.
 *
 * The renderer subscribes via `window.takusen.onJoinUri(...)` exposed by the
 * preload. We also keep an extension point for additional schemes Agent C
 * may need (e.g. `app.hachiman://oauth-callback`) — see `extraSchemeHandlers`.
 */
import { BrowserWindow, type App } from 'electron'
import path from 'path'

/** Channel used by the renderer to receive deep-link URIs. */
export const TAKUSEN_JOIN_URI_CHANNEL = 'takusen:join-uri'

const TAKUSEN_SCHEME = 'takusen'

export interface ExtraSchemeHandler {
  /** The scheme without the trailing ':' (e.g. 'hachiman'). */
  scheme: string
  /** IPC channel that will receive URLs matching this scheme. */
  channel: string
}

interface RegisterOptions {
  /** Function returning the main window (created lazily). */
  getMainWindow: () => BrowserWindow | null
  /** Additional schemes to claim alongside `takusen://`. */
  extraSchemeHandlers?: ExtraSchemeHandler[]
}

/**
 * Register the takusen:// scheme as the default protocol client and wire up
 * single-instance + open-url handling. Must be called BEFORE `app.whenReady`
 * resolves so the single-instance lock takes effect before any windows open.
 *
 * Returns `false` if the single-instance lock failed (this process is the
 * second instance) — the caller MUST quit immediately in that case to let
 * the existing instance handle the URL.
 */
export function registerProtocolHandlers(
  electronApp: App,
  options: RegisterOptions,
): boolean {
  setAsDefaultClient(electronApp, TAKUSEN_SCHEME)
  for (const extra of options.extraSchemeHandlers ?? []) {
    setAsDefaultClient(electronApp, extra.scheme)
  }

  // Single-instance lock — without this, clicking takusen://… on Win/Linux
  // spawns a fresh process every time and the running window never sees the
  // URL.
  const gotLock = electronApp.requestSingleInstanceLock()
  if (!gotLock) {
    return false
  }

  // The list of schemes we care about routing to the renderer.
  const channelByScheme = new Map<string, string>()
  channelByScheme.set(TAKUSEN_SCHEME, TAKUSEN_JOIN_URI_CHANNEL)
  for (const extra of options.extraSchemeHandlers ?? []) {
    channelByScheme.set(extra.scheme, extra.channel)
  }

  const isHandledUrl = (s: string): string | null => {
    for (const scheme of channelByScheme.keys()) {
      if (s.startsWith(`${scheme}://`)) return scheme
    }
    return null
  }

  const dispatchUrlToWindow = (url: string): void => {
    const scheme = isHandledUrl(url)
    if (!scheme) return
    const channel = channelByScheme.get(scheme)
    if (!channel) return
    const win = options.getMainWindow()
    if (!win) {
      // Window hasn't been created yet — stash and replay once it's ready.
      pendingUrls.push({ channel, url })
      return
    }
    if (win.isMinimized()) win.restore()
    win.focus()
    win.webContents.send(channel, url)
  }

  // Buffer URLs that arrive before the renderer is up. Drained by
  // `flushPendingUrls()` once a window is created (call this from the main
  // process after `createWindow`).
  const pendingUrls: { channel: string; url: string }[] = []

  // (2) Windows / Linux: second-instance hand-off.
  electronApp.on('second-instance', (_event, argv) => {
    const url = argv.find((arg) => isHandledUrl(arg) !== null)
    if (url) dispatchUrlToWindow(url)
  })

  // (2) macOS: open-url is the only way to get the URL on macOS, both for
  // cold-start (fires shortly after `ready`) and for already-running.
  electronApp.on('open-url', (event, url) => {
    event.preventDefault()
    dispatchUrlToWindow(url)
  })

  // (1) Windows / Linux cold-start: scan argv now and queue. The first
  // BrowserWindow constructed will drain via `flushPendingUrls`.
  for (const arg of process.argv) {
    const scheme = isHandledUrl(arg)
    if (scheme) {
      const channel = channelByScheme.get(scheme)
      if (channel) pendingUrls.push({ channel, url: arg })
    }
  }

  // Stash the drain function on the module-scoped state.
  flushPendingUrlsImpl = (win: BrowserWindow) => {
    if (pendingUrls.length === 0) return
    // Run on next tick so the renderer has time to subscribe via preload.
    setTimeout(() => {
      for (const { channel, url } of pendingUrls.splice(0)) {
        win.webContents.send(channel, url)
      }
    }, 100)
  }

  return true
}

let flushPendingUrlsImpl: ((win: BrowserWindow) => void) | null = null

/**
 * Call this once the main BrowserWindow has been created so any URLs that
 * came in via cold-start argv get delivered. Safe to call multiple times.
 */
export function flushPendingUrls(win: BrowserWindow): void {
  flushPendingUrlsImpl?.(win)
}

/**
 * `setAsDefaultProtocolClient` quirks:
 *  - On Windows in dev (electron-vite), the running binary is `electron.exe`
 *    and the registry entry needs to point back at it with the entry script.
 *    Without the extra args, clicking the URL would launch electron.exe with
 *    no project and just show the default app.
 *  - On packaged builds the defaults are fine.
 */
function setAsDefaultClient(electronApp: App, scheme: string): void {
  if (process.defaultApp) {
    // dev (`electron-vite dev`): point the registry back at the project
    // entry so the launched process knows what to load.
    if (process.argv.length >= 2) {
      electronApp.setAsDefaultProtocolClient(scheme, process.execPath, [
        path.resolve(process.argv[1]),
      ])
    }
  } else {
    electronApp.setAsDefaultProtocolClient(scheme)
  }
}
