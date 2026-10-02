/**
 * PUT /api/v1/users/@me/device-signing-key {cert} — a new DSK (generation + 1)
 * under the current master key. Deletes stale key packages, KEY_PACKAGES_LOW to
 * each device, USER_KEYS_UPDATE dsk_rotated (§12.7.2, §12.12).
 */
import { z } from 'zod'

import { requireMe } from '@/lib/api-helpers'
import { b64 } from '@/lib/mls/bytes'
import { putDeviceSigningKey } from '@/lib/mls/identity'
import { body, dsRoute, noContent } from '@/lib/mls/route'

const schema = z.object({ cert: b64(1024) })

export const PUT = dsRoute<{ id: string }>('active', async (ctx) => {
  requireMe(ctx.params.id)
  const { cert } = await body(ctx.req, schema)
  await putDeviceSigningKey(ctx.repo, await ctx.deps(), ctx.out, ctx.userId, cert)
  return noContent()
})
