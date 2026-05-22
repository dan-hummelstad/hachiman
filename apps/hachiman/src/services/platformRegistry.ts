import type { IMumbleServiceFactory } from '@/shared/IMumbleService'

/**
 * Module-level registry the React `PlatformProvider` seeds at mount time so the
 * pre-existing singleton services (ServersService, ChannelsService, VoiceService)
 * can reach the platform-specific Mumble service factory without rewriting them
 * as React hooks.
 *
 * The factory MUST be registered before any service method that constructs a
 * connection is called. PlatformProvider does this synchronously during render.
 */
let mumbleServiceFactory: IMumbleServiceFactory | null = null

export function registerMumbleServiceFactory(factory: IMumbleServiceFactory): void {
  mumbleServiceFactory = factory
}

export function getMumbleServiceFactory(): IMumbleServiceFactory {
  if (!mumbleServiceFactory) {
    throw new Error(
      'No IMumbleServiceFactory has been registered. Make sure the app is wrapped in <PlatformProvider>.'
    )
  }
  return mumbleServiceFactory
}
