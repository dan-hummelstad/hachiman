/**
 * GET    /api/v1/backups — BackupIndex of the user.
 * DELETE /api/v1/backups — every backup blob of the user (§12.11.3, §12.12).
 */
import { backupIndex } from '@/lib/mls/device-data'
import { dsRoute, json, noContent } from '@/lib/mls/route'

export const GET = dsRoute('active', async (ctx) => json(await backupIndex(ctx.repo, ctx.userId)))

export const DELETE = dsRoute('active', async (ctx) => {
  await ctx.repo.deleteBackups(ctx.userId)
  return noContent()
})
