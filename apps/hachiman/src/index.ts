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
