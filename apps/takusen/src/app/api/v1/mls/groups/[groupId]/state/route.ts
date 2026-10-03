/**
 * GET /api/v1/mls/groups/:groupId/state?epoch= — GroupState, the latest when no
 * epoch is given. 410 EpochNotKept (§12.7.6).
 */
import { groupState, parseGroupIdParam } from '@/lib/mls/groups'
import { dsRoute, json } from '@/lib/mls/route'

export const GET = dsRoute<{ groupId: string }>('active', async (ctx) =>
  json(await groupState(ctx.repo, parseGroupIdParam(ctx.params.groupId), ctx.userId, ctx.req.nextUrl.searchParams.get('epoch'))),
)
