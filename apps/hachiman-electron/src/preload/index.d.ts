import { ElectronAPI } from '@electron-toolkit/preload'

declare global {
  interface Window {
    electron: ElectronAPI
    api: unknown
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
