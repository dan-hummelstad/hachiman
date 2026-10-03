/**
 * POST /api/v1/devices/link-sessions {offer} — by the new (pending) device. DEVICE_LINK → user:{me}.
 * GET  /api/v1/devices/link-sessions — the open sessions of the user (§12.5, §12.12).
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { rateLimit } from '@/lib/mls/context'
import { createLinkSession, listLinkSessions } from '@/lib/mls/device-data'
import { body, dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

const schema = z.object({ offer: b64(1024) })

export const POST = dsRoute('pending', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const { offer } = await body(ctx.req, schema)
  const deps = await ctx.deps()
  await rateLimit(deps, 'linkSessions', ctx.userId)
  return json(await createLinkSession(ctx.repo, ctx.out, { userId: ctx.userId, device }, offer, deps.now()), 201)
})

export const GET = dsRoute('pending', async (ctx) => json(await listLinkSessions(ctx.repo, ctx.userId, new Date())))
