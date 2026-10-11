import type { DevicePlatform } from '@hachiman/crypto'

/** The kind of app that a device runs, as the device lists show it. */
export const PLATFORM_LABEL: Record<DevicePlatform, string> = {
  electron: 'Desktop app',
  browser: 'Browser',
  ios: 'iPhone app'
}
