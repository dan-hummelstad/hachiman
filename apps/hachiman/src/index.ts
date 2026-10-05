// Public entry point for the shared renderer library, consumed by the hosts
// (hachiman-electron, hachiman-browser).

import './assets/main.css'

export { default as App } from './App'
export { ThemeProvider } from './components/theme-provider'

// Platform seam (contract §11)
export { PlatformProvider, usePlatform } from './shared/PlatformContext'
export type {
  IPlatformService,
  RegionProbeTarget,
  RegionProbeResult,
  ScreenSource,
  UpdateCheckResult
} from './shared/IPlatformService'

// Takusen SSO. The App completes sign-in itself via `platform.onOAuthCallback`;
// the Electron host reads `takusenService.env` for its redirect URI.
export { takusenService } from './services/TakusenService'

// Invite links: `takusen://invite/<code>`, `https://<host>/invite/<code>`, or a bare code → code.
export { parseInviteCode } from './services/InviteService'
