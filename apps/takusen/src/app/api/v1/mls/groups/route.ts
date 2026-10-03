/**
 * GET  /api/v1/mls/groups — the groups that the user reads, `member` per the caller device.
 * POST /api/v1/mls/groups CreateGroupRequest — the assignee creates a pending
 *      group at epoch 0 (§12.7.7). 201 MlsGroup. MLS_GROUP_UPDATE.
 */
import { z } from 'zod'

import { ApiError } from '@/lib/errors'
import { b64 } from '@/lib/mls/bytes'
import { createGroup, listGroupsForUser } from '@/lib/mls/groups'
import { body, dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

export const GET = dsRoute('active', async (ctx) => json(await listGroupsForUser(ctx.repo, ctx.userId, requireRouteDevice(ctx).id)))

const schema = z.object({
  groupId: b64(64),
  kind: z.enum(['public_set', 'channel', 'dm']),
  guildId: z.string().uuid().nullable(),
  channelId: z.string().uuid().nullable(),
  cipherSuite: z.number().int(),
  groupInfo: b64(256 * 1024),
  ratchetTree: b64(64 * 1024),
  assignmentId: z.string().uuid().nullable(),
})

export const POST = dsRoute('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const b = await body(ctx.req, schema)
  if (b.groupId.length !== 22) throw new ApiError('InvalidCommit', 400, 'a group id has 22 bytes')
  const group = await createGroup(ctx.repo, await ctx.deps(), ctx.out, { userId: ctx.userId, device }, b)
  return json(group, 201)
})
