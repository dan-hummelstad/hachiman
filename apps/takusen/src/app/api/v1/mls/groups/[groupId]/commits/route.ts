/**
 * POST /api/v1/mls/groups/:groupId/commits CommitRequest → {epoch, seq} (201).
 * 409 EpochConflict {epoch}. MLS_HANDSHAKE; DEVICE_INBOX per Welcome (§12.7.3).
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { uploadCommit } from '@/lib/mls/commits'
import { INBOX_ITEM_MAX_BYTES } from '@/lib/mls/config'
import { rateLimit } from '@/lib/mls/context'
import { parseGroupIdParam } from '@/lib/mls/groups'
import { body, dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

const MIB = 1024 * 1024

const schema = z.object({
  epoch: z.number().int().nonnegative(),
  commit: b64(MIB),
  groupInfo: b64(64 * 1024),
  ratchetTree: b64(8 * MIB),
  welcome: b64(INBOX_ITEM_MAX_BYTES).nullable(),
  batchId: z.string().uuid().nullable(),
  rejected: z
    .array(z.object({ pendingId: z.string().uuid(), reason: z.enum(['invalid_chain', 'not_reader', 'revoked', 'policy', 'malformed']) }))
    .max(200),
})

export const POST = dsRoute<{ groupId: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const groupId = parseGroupIdParam(ctx.params.groupId)
  const deps = await ctx.deps()
  await rateLimit(deps, 'commits', device.id)
  const b = await body(ctx.req, schema)
  return json(await uploadCommit(ctx.repo, deps, ctx.out, { userId: ctx.userId, device }, groupId, b), 201)
})
