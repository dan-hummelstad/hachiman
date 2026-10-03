/**
 * GET /api/v1/mls/join-requests/:id → JoinRequest (§12.12).
 */
import { getJoinRequest } from '@/lib/mls/joins'
import { dsRoute, json, uuidParam } from '@/lib/mls/route'

export const GET = dsRoute<{ id: string }>('active', async (ctx) =>
  json(await getJoinRequest(ctx.repo, { userId: ctx.userId }, uuidParam(ctx.params.id, 'join request'))),
)
