/**
 * POST /api/v1/backups/history {keyId, groupId, epochFrom, epochTo, blob} → {id} (201).
 * 409 WrongBackupKey; 413 BackupTooLarge (§12.11.3).
 */
import { z } from 'zod'

import { b64 } from '@/lib/mls/bytes'
import { rateLimit } from '@/lib/mls/context'
import { postHistoryBackup } from '@/lib/mls/device-data'
import { body, dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

const schema = z.object({
  keyId: b64(16).refine((b) => b.length === 16, 'keyId has 16 bytes'),
  groupId: b64(64),
  epochFrom: z.number().int().nonnegative(),
  epochTo: z.number().int().nonnegative(),
  blob: b64(),
})

export const POST = dsRoute('active', async (ctx) => {
  const device = requireRouteDevice(ctx)
  const deps = await ctx.deps()
  await rateLimit(deps, 'backups', device.id)
  const b = await body(ctx.req, schema)
  return json(await postHistoryBackup(ctx.repo, ctx.userId, b), 201)
})
