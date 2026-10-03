/**
 * GET /api/v1/users/:id/keys — UserKeys, with the KT entry beside each ktIndex (§12.12, §12.14).
 * The caller shares a guild or a DM with the user, or is the user.
 */
import { userKeys } from '@/lib/mls/identity'
import { dsRoute, json, meOr, uuidParam } from '@/lib/mls/route'

export const GET = dsRoute<{ id: string }>('none', async (ctx) => {
  const userId = uuidParam(meOr(ctx.params.id, ctx.userId), 'user')
  return json(await userKeys(ctx.repo, await ctx.deps(), ctx.userId, userId))
})
