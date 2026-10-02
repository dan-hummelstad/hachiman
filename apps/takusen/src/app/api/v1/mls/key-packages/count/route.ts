/**
 * GET /api/v1/mls/key-packages/count → {cipherSuite, count, lastResort}[] for the caller device (§12.12).
 */
import { countKeyPackages } from '@/lib/mls/key-packages'
import { dsRoute, json, requireRouteDevice } from '@/lib/mls/route'

export const GET = dsRoute('active', async (ctx) => json(await countKeyPackages(ctx.repo, requireRouteDevice(ctx))))
