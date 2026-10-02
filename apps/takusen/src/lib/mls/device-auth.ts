/**
 * The `X-Hachiman-Device` check of the routes marked D in §12.12: the device
 * belongs to the user and is not revoked. `pending` devices pass only with
 * `allowPending` (the device and link routes).
 */
import { ApiError } from '@/lib/errors'

import { drizzleMlsRepo } from './repo.drizzle'
import type { DeviceRow, MlsRepo } from './repo'

export const DEVICE_HEADER = 'x-hachiman-device'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** last_seen_at is written at most this often per device. */
const LAST_SEEN_RESOLUTION_MS = 5 * 60_000

export async function requireDevice(req: Request, userId: string, opts?: { allowPending?: boolean }): Promise<DeviceRow> {
  return requireDeviceWith(drizzleMlsRepo(), req.headers.get(DEVICE_HEADER), userId, opts)
}

export async function requireDeviceWith(
  repo: MlsRepo,
  header: string | null,
  userId: string,
  opts: { allowPending?: boolean } = {},
  now: Date = new Date(),
): Promise<DeviceRow> {
  const id = header?.trim().toLowerCase() ?? ''
  if (!id) throw new ApiError('DeviceRequired', 400, 'X-Hachiman-Device is required')
  if (!UUID.test(id)) throw new ApiError('DeviceRequired', 400, 'X-Hachiman-Device is not a device id')
  const device = await repo.getDevice(id)
  if (!device || device.userId !== userId) throw new ApiError('DeviceNotActive', 403, 'unknown device')
  if (device.status === 'revoked') throw new ApiError('DeviceNotActive', 403, 'device revoked')
  if (device.status === 'pending' && !opts.allowPending) throw new ApiError('DeviceNotActive', 403, 'device not active')
  if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() > LAST_SEEN_RESOLUTION_MS) {
    await repo.updateDevice(device.id, { lastSeenAt: now })
  }
  return device
}

/** `@me` (or the caller's own id) → the caller device. Other ids → that id. */
export function resolveDeviceParam(param: string, caller: DeviceRow): string {
  return param === '@me' || param === '%40me' ? caller.id : param
}
