/**
 * GET /api/v1/mls/groups/:groupId — MlsGroup (§12.12). 404 UnknownGroup when the caller cannot read it.
 */
import { parseGroupIdParam, requireReadableGroup, wireGroupFor } from '@/lib/mls/groups'
import { dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

export const GET = dsRoute<{ groupId: string }>('active', async (ctx) => {
  const { group } = await requireReadableGroup(ctx.repo, parseGroupIdParam(ctx.params.groupId), ctx.userId)
  return json(await wireGroupFor(ctx.repo, group, requireRouteDevice(ctx).id))
})
