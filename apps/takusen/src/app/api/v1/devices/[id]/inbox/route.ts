/**
 * GET  /api/v1/devices/@me/inbox?after=&limit= — the caller device's items, ascending seq, limit ≤ 100.
 * POST /api/v1/devices/:id/inbox {kind, body} — a sealed device message to a device of the same user.
 * (§12.7.6, §12.12. `/devices/@me/...` lives under `devices/[id]`.)
 */
import { z } from 'zod'

import { ApiError } from '@/lib/errors'
import { b64 } from '@/lib/mls/bytes'
import { INBOX_ITEM_MAX_BYTES } from '@/lib/mls/config'
import { rateLimit } from '@/lib/mls/context'
import { resolveDeviceParam } from '@/lib/mls/device-auth'
import { listInbox, postInbox } from '@/lib/mls/device-data'
import { body, dsRoute, intQuery, json, noContent, requireRouteDevice, uuidParam } from '@/lib/mls/route'

export const GET = dsRoute<{ id: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  if (resolveDeviceParam(ctx.params.id, device) !== device.id) throw new ApiError('NotFound', 404, 'only the own inbox')
  const q = ctx.req.nextUrl.searchParams
  return json(await listInbox(ctx.repo, device, intQuery(q, 'after', 0), intQuery(q, 'limit', 100, 100) || 100, new Date()))
})

const postSchema = z.object({
  kind: z.enum(['dsk_transfer', 'history_keys']),
  body: z.string(),
})

export const POST = dsRoute<{ id: string }>('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const target = uuidParam(resolveDeviceParam(ctx.params.id, device), 'device', 'UnknownDevice')
  const raw = await body(ctx.req, postSchema)
  const bytes = b64().safeParse(raw.body)
  if (!bytes.success) throw new ApiError('ValidationError', 400, 'body must be base64url')
  if (bytes.data.length > INBOX_ITEM_MAX_BYTES) throw new ApiError('InboxFull', 413, 'the item is above 1 MiB')
  const deps = await ctx.deps()
  await rateLimit(deps, 'inboxPosts', device.id)
  await postInbox(ctx.repo, ctx.out, { userId: ctx.userId, device }, target, { kind: raw.kind, body: bytes.data }, deps.now())
  return noContent()
})
