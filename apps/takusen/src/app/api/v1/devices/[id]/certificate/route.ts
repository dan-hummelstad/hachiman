/**
 * PUT /api/v1/devices/:id/certificate {certificate} — certifies a device under
 * the current DSK; the device becomes active (§12.12). USER_KEYS_UPDATE device_added.
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { resolveDeviceParam } from '@/lib/mls/device-auth'
import { putCertificate } from '@/lib/mls/identity'
import { body, dsRoute, json, requireRouteDevice, uuidParam } from '@/lib/mls/route'

const schema = z.object({ certificate: b64(4096) })

export const PUT = dsRoute<{ id: string }>('pending', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const id = uuidParam(resolveDeviceParam(ctx.params.id, device), 'device', 'UnknownDevice')
  const { certificate } = await body(ctx.req, schema)
  const deps = await ctx.deps()
  return json(await putCertificate(ctx.repo, deps, ctx.out, { userId: ctx.userId, device }, id, certificate))
})
