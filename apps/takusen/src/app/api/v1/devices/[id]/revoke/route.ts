/**
 * POST /api/v1/devices/:id/revoke {revocation, reason} — a signed revocation (§12.4, §12.12).
 * `revocation: null` only for a pending device that signs itself out.
 * USER_KEYS_UPDATE device_revoked; DEVICE_REVOKED → device:{id}.
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { resolveDeviceParam } from '@/lib/mls/device-auth'
import { revokeDevice } from '@/lib/mls/identity'
import { body, dsRoute, noContent, requireRouteDevice, uuidParam } from '@/lib/mls/route'

const schema = z.object({
  revocation: b64(1024).nullable(),
  reason: z.enum(['user', 'lost', 'compromised', 'signed_out']),
})

export const POST = dsRoute<{ id: string }>('pending', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const id = uuidParam(resolveDeviceParam(ctx.params.id, device), 'device', 'UnknownDevice')
  const b = await body(ctx.req, schema)
  await revokeDevice(ctx.repo, await ctx.deps(), ctx.out, { userId: ctx.userId, device }, id, b)
  return noContent()
})
