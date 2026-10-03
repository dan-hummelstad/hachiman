/**
 * POST /api/v1/mls/groups/:groupId/history-bundles {epoch, blob} — 201, one per (group, epoch, sender).
 * GET  /api/v1/mls/groups/:groupId/history-bundles?epoch= → HistoryBundle[] (§12.11.2).
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { HISTORY_BUNDLE_MAX_BYTES } from '@/lib/mls/crypto'
import { listHistoryBundles, postHistoryBundle } from '@/lib/mls/device-data'
import { parseGroupIdParam } from '@/lib/mls/groups'
import { body, dsRoute, intQuery, json, requireRouteDevice } from '@/lib/mls/route'

const schema = z.object({ epoch: z.number().int().nonnegative(), blob: b64(HISTORY_BUNDLE_MAX_BYTES) })

export const POST = dsRoute<{ groupId: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const b = await body(ctx.req, schema)
  await postHistoryBundle(ctx.repo, { userId: ctx.userId, device }, parseGroupIdParam(ctx.params.groupId), b)
  return json({}, 201)
})

export const GET = dsRoute<{ groupId: string }>('active', async (ctx) => {
  const epoch = intQuery(ctx.req.nextUrl.searchParams, 'epoch', 0)
  return json(await listHistoryBundles(ctx.repo, ctx.userId, parseGroupIdParam(ctx.params.groupId), epoch))
})
