/**
 * POST /api/v1/mls/batches/:id/decline {reason: 'not_synced' | 'busy',
 * rejectedProposals?: [{proposalRef, reason}]} — 204. The batch goes to the
 * next device at once (MLS_BATCH_ASSIGN, §12.7.5). The DS Add proposals that
 * the committer refused are marked rejected first, so the next batch leaves
 * them out (MLS_JOIN_UPDATE rejected to a joiner). Body schema: lib/mls/schemas.ts.
 */
import { declineBatch } from '@/lib/mls/batches'
import { body, dsRoute, noContent, requireRouteDevice, uuidParam } from '@/lib/mls/route'
import { declineBatchSchema } from '@/lib/mls/schemas'

export const POST = dsRoute<{ id: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const b = await body(ctx.req, declineBatchSchema)
  await declineBatch(ctx.repo, await ctx.deps(), ctx.out, device.id, uuidParam(ctx.params.id, 'batch', 'UnknownBatch'), b.rejectedProposals)
  return noContent()
})
