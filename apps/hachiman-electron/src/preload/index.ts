import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { RegionProbeResult, RegionProbeTarget } from '@hachiman/hachiman-node'

// Custom APIs for renderer. `probeRegions` relays region-latency probe targets
// to the main process (where raw node sockets live) and returns the measured
// RTTs. The channel name MUST match `ipcMain.handle('hachiman:probe-regions')`
// in main/index.ts.
const api = {
  probeRegions(targets: RegionProbeTarget[]): Promise<RegionProbeResult[]> {
    return ipcRenderer.invoke('hachiman:probe-regions', targets) as Promise<
      RegionProbeResult[]
    >
  }
}

// `takusen://` deep-link bridge. The main process pushes inbound URIs over
// IPC; we expose a thin subscribe-style API to the renderer so the shared UI
// can listen without depending on Electron directly. The channel name MUST
// stay in sync with `TAKUSEN_JOIN_URI_CHANNEL` in main/protocol-handler.ts.
const TAKUSEN_JOIN_URI_CHANNEL = 'takusen:join-uri'

const takusen = {
  onJoinUri(callback: (uri: string) => void): () => void {
    const listener = (_event: unknown, uri: string): void => {
      try {
        callback(uri)
      } catch (err) {
        // Don't let a renderer-side bug poison the IPC channel.
        console.error('[takusen] join-uri listener threw:', err)
      }
    }
    ipcRenderer.on(TAKUSEN_JOIN_URI_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(TAKUSEN_JOIN_URI_CHANNEL, listener)
    }
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('takusen', takusen)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.takusen = takusen
}
