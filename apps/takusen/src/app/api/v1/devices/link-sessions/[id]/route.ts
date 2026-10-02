/**
 * DELETE /api/v1/devices/link-sessions/:id (§12.12).
 */
import { deleteLinkSession } from '@/lib/mls/device-data'
import { dsRoute, noContent, uuidParam } from '@/lib/mls/route'

export const DELETE = dsRoute<{ id: string }>('pending', async (ctx) => {
  await deleteLinkSession(ctx.repo, ctx.userId, uuidParam(ctx.params.id, 'link session'))
  return noContent()
})
