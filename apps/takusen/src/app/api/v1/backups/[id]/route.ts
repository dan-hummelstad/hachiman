/**
 * GET /api/v1/backups/:id → {blob} (§12.12).
 */
import { getBackup } from '@/lib/mls/device-data'
import { dsRoute, json, uuidParam } from '@/lib/mls/route'

export const GET = dsRoute<{ id: string }>('pending', async (ctx) => json(await getBackup(ctx.repo, ctx.userId, uuidParam(ctx.params.id, 'backup'))))
