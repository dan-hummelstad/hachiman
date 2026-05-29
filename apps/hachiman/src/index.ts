// Public entry point for the `hachiman` shared renderer library.
// Consumed by the platform-specific apps (hachiman-electron, hachiman-browser).

import './assets/main.css'

export { default as App } from './App'
export { ThemeProvider, useTheme } from './components/theme-provider'

// Platform abstraction surface
export { PlatformProvider, usePlatform } from './shared/PlatformContext'
export type { PlatformContextValue } from './shared/PlatformContext'
export type {
  IMumbleService,
  IMumbleServiceFactory,
  MumbleConnectOptions,
  MumbleEvents,
  MumbleEventHandler
} from './shared/IMumbleService'
export type { IPlatformService } from './shared/IPlatformService'
// Re-exported from the client lib so host PlatformService impls and region-aware
// UI can type their probe surface against the shared package.
export type { RegionProbeResult, RegionProbeTarget } from '@hachiman/hachiman-node'

// Relay voice-health types + the wire→UI mapper, so host MumbleService impls
// can turn a RelayMetricsSnapshot into the RelayPathSnapshot the Health tab
// renders without duplicating the mapping per platform.
export { relayPathFromMetrics } from './lib/connection-quality'
export type {
  RelayPathSnapshot,
  RelayPathHop,
  RelayMetricsSnapshotLike
} from './lib/connection-quality'

// Oracle / Takusen SSO surface — host apps need these for the OAuth callback
// flow and for the deep-link handler (agent D).
export { oracleService, OracleService } from './services/OracleService'
export type { PKCEFlow } from './services/OracleService'
export { useOracleStore } from './stores/oracleStore'
export type { OracleSession, OracleUser } from './stores/oracleStore'
export { serversService } from './services/ServersService'
