/**
 * GET /api/v1/channels/:id/mls-group — the current group of the channel, or 404 UnknownGroup (§12.12).
 */
import { channelGroup } from '@/lib/mls/groups'
import { dsRoute, json, requireRouteDevice, uuidParam } from '@/lib/mls/route'

export const GET = dsRoute<{ id: string }>('active', async (ctx) =>
  json(await channelGroup(ctx.repo, uuidParam(ctx.params.id, 'group', 'UnknownGroup'), ctx.userId, requireRouteDevice(ctx).id)),
)
