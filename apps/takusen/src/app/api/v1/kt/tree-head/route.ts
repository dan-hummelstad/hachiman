/**
 * GET /api/v1/kt/tree-head → KtTreeHead, the newest signed head (§12.14).
 */
import { treeHead } from '@/lib/mls/kt'
import { dsRoute, json } from '@/lib/mls/route'

export const GET = dsRoute('none', async (ctx) => json(await treeHead(ctx.repo, (await ctx.deps()).ds)))
