/**
 * POST /api/v1/invite-records/:inviteId/bundles {groupId, epoch, blob} → 204
 * (§12.11.4, §12.12). The caller reads the group, the group is of the guild of
 * the invite, and the invite is active with a record. Takusen keeps at most
 * INVITE_BUNDLES_SENDER_MAX_BYTES per sender user (the creator is exempt) and
 * INVITE_BUNDLES_MAX_BYTES per invite, and deletes the oldest bundles above them.
 */
import { z } from 'zod'

import { drizzleInviteHistoryStore, postInviteBundle } from '@/lib/invite-history'
import { b64 } from '@/lib/mls/bytes'
import { rateLimitDevice } from '@/lib/mls/context'
import { INVITE_BUNDLE_MAX_BYTES } from '@/lib/mls/crypto'
import { body, dsRoute, noContent, requireRouteDevice, uuidParam } from '@/lib/mls/route'

const schema = z.object({ groupId: b64(64), epoch: z.number().int().nonnegative(), blob: b64(INVITE_BUNDLE_MAX_BYTES) })

export const POST = dsRoute<{ inviteId: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const deps = await ctx.deps()
  await rateLimitDevice(deps, 'inviteBundles', device)
  const inviteId = uuidParam(ctx.params.inviteId, 'invite', 'UnknownInvite')
  const b = await body(ctx.req, schema)
  await postInviteBundle(drizzleInviteHistoryStore(), ctx.repo, { userId: ctx.userId, device }, inviteId, b, deps.now())
  return noContent()
})
