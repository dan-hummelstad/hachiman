// Public entry point for the shared renderer library, consumed by the hosts
// (hachiman-electron, hachiman-browser, hachiman-ios).

import './assets/main.css'

export { default as App } from './App'
export { ThemeProvider } from './components/theme-provider'

// Platform seam (contract §11)
export { PlatformProvider, usePlatform } from './shared/PlatformContext'
export type {
  Appearance,
  HapticKind,
  InviteLink,
  IPlatformService,
  RegionProbeTarget,
  RegionProbeResult,
  ScreenSource,
  ShareContent,
  UpdateCheckResult
} from './shared/IPlatformService'

// Takusen SSO. The App completes sign-in itself via `platform.onOAuthCallback`;
// the Electron host reads `takusenService.env` for its redirect URI.
export { takusenService } from './services/TakusenService'

// Invite links: `takusen://invite/<code>`, `https://<host>/invite/<code>` (with `#k=<key>` for an
// invite with history), or a bare code → code and key. A malformed key gives null.
export { parseInviteCode, parseInviteLink } from './lib/invite-link'
