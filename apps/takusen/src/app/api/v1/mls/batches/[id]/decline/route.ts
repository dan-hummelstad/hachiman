/**
 * POST /api/v1/mls/batches/:id/decline {reason: 'not_synced' | 'busy'} — 204.
 * The batch goes to the next device at once (MLS_BATCH_ASSIGN, §12.7.5).
 */
import { z } from 'zod'

import { declineBatch } from '@/lib/mls/batches'
import { body, dsRoute, noContent, requireRouteDevice, uuidParam } from '@/lib/mls/route'

const schema = z.object({ reason: z.enum(['not_synced', 'busy']) })

export const POST = dsRoute<{ id: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  await body(ctx.req, schema)
  await declineBatch(ctx.repo, await ctx.deps(), ctx.out, device.id, uuidParam(ctx.params.id, 'batch', 'UnknownBatch'))
  return noContent()
})
