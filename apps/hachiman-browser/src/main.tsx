import '@hachiman/hachiman/style.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  App,
  ThemeProvider,
  PlatformProvider,
  type IMumbleServiceFactory,
  type IPlatformService,
  type MumbleConnectOptions
} from '@hachiman/hachiman'
import { MumbleService } from './platforms/browser/MumbleService'
import { PlatformService } from './platforms/browser/PlatformService'

const mumbleFactory: IMumbleServiceFactory = async (opts: MumbleConnectOptions) => {
  return new MumbleService(opts.serverUrl, opts.port, opts.username)
}

const platform: IPlatformService = new PlatformService()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PlatformProvider value={{ mumble: mumbleFactory, platform }}>
      <ThemeProvider defaultTheme="system" storageKey="hachiman-ui-theme">
        <App />
      </ThemeProvider>
    </PlatformProvider>
  </StrictMode>
)
