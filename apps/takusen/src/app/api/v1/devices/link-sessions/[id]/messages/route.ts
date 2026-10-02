/**
 * POST /api/v1/devices/link-sessions/:id/messages {body} — DEVICE_LINK → device:{peer}. 410 LinkExpired.
 * GET  /api/v1/devices/link-sessions/:id/messages?after= (§12.5, §12.12).
 */
import { z } from 'zod'

import { ApiError } from '@/lib/errors'
import { b64 } from '@/lib/mls/bytes'
import { LINK_MESSAGE_MAX_BYTES } from '@/lib/mls/config'
import { rateLimit } from '@/lib/mls/context'
import { listLinkMessages, postLinkMessage } from '@/lib/mls/device-data'
import { body, dsRoute, intQuery, json, requireRouteDevice, UUID_RE } from '@/lib/mls/route'

const schema = z.object({ body: b64(LINK_MESSAGE_MAX_BYTES) })

function sessionId(id: string): string {
  if (!UUID_RE.test(id)) throw new ApiError('LinkExpired', 410, 'the link session is gone')
  return id
}

export const POST = dsRoute<{ id: string }>('pending', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const b = await body(ctx.req, schema)
  const deps = await ctx.deps()
  await rateLimit(deps, 'linkMessages', device.id)
  return json(await postLinkMessage(ctx.repo, ctx.out, { userId: ctx.userId, device }, sessionId(ctx.params.id), b.body, deps.now()))
})

export const GET = dsRoute<{ id: string }>('pending', async (ctx) => {
  const after = intQuery(ctx.req.nextUrl.searchParams, 'after', 0)
  return json(await listLinkMessages(ctx.repo, { userId: ctx.userId }, sessionId(ctx.params.id), after, new Date()))
})
