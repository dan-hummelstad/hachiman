/**
 * PUT /api/v1/users/@me/master-key {record, dskCert} — the three cases of §12.12.
 * USER_KEYS_UPDATE master_key_changed. A pending device may call it (first device, reset).
 */
import { z } from 'zod'

import { requireMe } from '@/lib/api-helpers'
import { b64 } from '@/lib/mls/bytes'
import { putMasterKey } from '@/lib/mls/identity'
import { body, dsRoute, noContent } from '@/lib/mls/route'

const schema = z.object({ record: b64(1024), dskCert: b64(1024) })

export const PUT = dsRoute<{ id: string }>('pending', async (ctx) => {
  requireMe(ctx.params.id)
  const b = await body(ctx.req, schema)
  await putMasterKey(ctx.repo, await ctx.deps(), ctx.out, ctx.userId, b)
  return noContent()
})
