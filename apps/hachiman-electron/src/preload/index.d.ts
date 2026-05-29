import { ElectronAPI } from '@electron-toolkit/preload'
import type { RegionProbeResult, RegionProbeTarget } from '@hachiman/hachiman-node'

declare global {
  interface Window {
    electron: ElectronAPI
    /**
     * Custom preload bridge. `probeRegions` relays region-latency probe targets
     * to the main process (raw node sockets) and returns the measured RTTs.
     * Marked optional because the renderer only sees `window.api` under
     * Electron; the shared UI must defensively guard `window.api?.…`. This
     * augmentation applies because the electron `tsconfig.web.json` includes
     * `src/preload/*.d.ts` — the shared UI declares no ambient `Window['api']`,
     * so there is nothing to "merge" with here.
     */
    api?: {
      probeRegions(targets: RegionProbeTarget[]): Promise<RegionProbeResult[]>
    }
    /**
     * Bridge exposed by preload for takusen:// deep-link URIs forwarded by
     * the main process. Implementation lives in `src/preload/index.ts`.
     * Marked optional so the shared UI's ambient `Window['takusen']?` shape
     * (which the browser host doesn't populate) merges cleanly.
     */
    takusen?: {
      onJoinUri(callback: (uri: string) => void): () => void
    }
  }
}
