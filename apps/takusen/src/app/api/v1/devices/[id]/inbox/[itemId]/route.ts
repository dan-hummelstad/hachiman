/**
 * DELETE /api/v1/devices/@me/inbox/:id — acks one item of the caller device (§12.7.6).
 */
import { ApiError } from '@/lib/errors'
import { resolveDeviceParam } from '@/lib/mls/device-auth'
import { ackInbox } from '@/lib/mls/device-data'
import { dsRoute, noContent, requireRouteDevice, uuidParam } from '@/lib/mls/route'

export const DELETE = dsRoute<{ id: string; itemId: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  if (resolveDeviceParam(ctx.params.id, device) !== device.id) throw new ApiError('NotFound', 404, 'only the own inbox')
  await ackInbox(ctx.repo, device, uuidParam(ctx.params.itemId, 'inbox item'))
  return noContent()
})
