/**
 * PUT /api/v1/backups/identity {keyId, blob} — replaces the identity backup.
 * 413 BackupTooLarge above 64 KiB (§12.11.3).
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { rateLimitDevice } from '@/lib/mls/context'
import { putIdentityBackup } from '@/lib/mls/device-data'
import { body, dsRoute, noContent, requireRouteDevice } from '@/lib/mls/route'

const schema = z.object({
  keyId: b64(16).refine((b) => b.length === 16, 'keyId has 16 bytes'),
  blob: b64(),
})

export const PUT = dsRoute('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const deps = await ctx.deps()
  await rateLimitDevice(deps, 'backups', device)
  const b = await body(ctx.req, schema)
  await putIdentityBackup(ctx.repo, ctx.userId, b.keyId, b.blob)
  return noContent()
})
