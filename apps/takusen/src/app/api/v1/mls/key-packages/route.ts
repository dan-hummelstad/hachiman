/**
 * POST /api/v1/mls/key-packages {cipherSuite, keyPackages (≤ 100), lastResort} → {stored, total} (§12.7.2).
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { KEY_PACKAGE_UPLOAD_MAX } from '@/lib/mls/config'
import { rateLimitDevice } from '@/lib/mls/context'
import { uploadKeyPackages } from '@/lib/mls/key-packages'
import { body, dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

const KEY_PACKAGE_MAX_BYTES = 16 * 1024

const schema = z.object({
  cipherSuite: z.number().int(),
  keyPackages: z.array(b64(KEY_PACKAGE_MAX_BYTES)).max(KEY_PACKAGE_UPLOAD_MAX),
  lastResort: b64(KEY_PACKAGE_MAX_BYTES).nullable(),
})

export const POST = dsRoute('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const deps = await ctx.deps()
  await rateLimitDevice(deps, 'keyPackages', device)
  const b = await body(ctx.req, schema)
  return json(await uploadKeyPackages(ctx.repo, deps, device, b))
})
