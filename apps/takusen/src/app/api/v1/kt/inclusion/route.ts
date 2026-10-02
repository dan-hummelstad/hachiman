/**
 * GET /api/v1/kt/inclusion?index=&treeSize= → KtInclusionProof (RFC 6962 §2.1.1, §12.14).
 */
import { inclusionProof } from '@/lib/mls/kt'
import { dsRoute, json } from '@/lib/mls/route'

export const GET = dsRoute('none', async (ctx) => json(await inclusionProof(ctx.repo, (await ctx.deps()).ds, ctx.req.nextUrl.searchParams)))
