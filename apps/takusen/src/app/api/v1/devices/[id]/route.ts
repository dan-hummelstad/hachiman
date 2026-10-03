/**
 * PATCH /api/v1/devices/:id {name} — the REST name only; no new certificate (§12.5, §12.12).
 * `:id` may be `@me`.
 */
import { z } from 'zod'

import { resolveDeviceParam } from '@/lib/mls/device-auth'
import { renameDevice } from '@/lib/mls/identity'
import { body, dsRoute, json, requireRouteDevice, uuidParam } from '@/lib/mls/route'

const renameSchema = z.object({ name: z.string().trim().min(1).max(64) })

export const PATCH = dsRoute<{ id: string }>('pending', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const id = uuidParam(resolveDeviceParam(ctx.params.id, device), 'device', 'UnknownDevice')
  const { name } = await body(ctx.req, renameSchema)
  return json(await renameDevice(ctx.repo, ctx.userId, id, name))
})
