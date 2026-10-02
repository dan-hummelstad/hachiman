/**
 * POST /api/v1/mls/groups/:groupId/join-requests {keyPackage} → JoinRequest (202).
 * 403 GroupFull. MLS_JOIN_UPDATE (§12.7.8).
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { rateLimit } from '@/lib/mls/context'
import { parseGroupIdParam } from '@/lib/mls/groups'
import { postJoinRequest } from '@/lib/mls/joins'
import { body, dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

const schema = z.object({ keyPackage: b64(16 * 1024) })

export const POST = dsRoute<{ groupId: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const groupId = parseGroupIdParam(ctx.params.groupId)
  const deps = await ctx.deps()
  await rateLimit(deps, 'joinRequests', device.id)
  const { keyPackage } = await body(ctx.req, schema)
  return json(await postJoinRequest(ctx.repo, deps, ctx.out, { userId: ctx.userId, device }, groupId, keyPackage), 202)
})
