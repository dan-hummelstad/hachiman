import type { DeviceSummary } from '@hachiman/crypto'

/**
 * What brings the history of this device back after a sign-out that removes its keys (M35):
 * - `recovery`: the recovery key. The user ticks that they know where it is.
 * - `devices`: no recovery key, but another active device can link this one again.
 * - `lost`: neither. The callout is red, and the user ticks that the history is lost.
 * - `unknown`: no recovery key, and the device list did not load. Red as `lost`: without proof of
 *   another device the sheet warns.
 * - `loading`: no recovery key, and the device list is not loaded yet.
 */
export type SignOutCase = 'recovery' | 'devices' | 'lost' | 'unknown' | 'loading'

/**
 * The case of a sign-out. `others`: the names of the other active devices, or null while the list
 * loads or after it failed (`listFailed`).
 */
export function signOutCase(
  recovery: boolean,
  others: readonly string[] | null,
  listFailed = false
): SignOutCase {
  if (recovery) return 'recovery'
  if (others === null) return listFailed ? 'unknown' : 'loading'
  return others.length > 0 ? 'devices' : 'lost'
}

/** The sign-out needs a ticked box first. */
export const needsAck = (c: SignOutCase): boolean =>
  c === 'recovery' || c === 'lost' || c === 'unknown'

/** The names of the other devices that hold keys: active, and not this one. */
export function otherDeviceNames(devices: readonly DeviceSummary[]): string[] {
  return devices.filter((d) => !d.current && d.status === 'active').map((d) => d.name)
}

/** At most this many names show; the rest is "n more". */
const MAX_NAMES = 2

/**
 * The names as a phrase: "A", "A and B", "A, B and 2 more". `max` names show at most before the
 * count of the rest.
 */
export function joinNames(names: readonly string[], max = MAX_NAMES): string {
  if (names.length <= 1) return names[0] ?? ''
  if (names.length <= max) return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`
}
