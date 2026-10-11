import type { DevicePlatform } from '@hachiman/crypto'

/** The kind of app that a device runs, as the device lists show it. */
export const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  electron: 'Desktop app',
  browser: 'Browser',
  ios: 'iPhone app'
}

/**
 * The default name of a new device on each platform (the user can rename it). A contact's device
 * carries only its signed name, so the verification sheet reads the platform back from it.
 */
export const DEVICE_NAME: Record<DevicePlatform, string> = {
  electron: 'Hachiman Desktop',
  browser: 'Hachiman Web',
  ios: 'Hachiman iOS'
}
