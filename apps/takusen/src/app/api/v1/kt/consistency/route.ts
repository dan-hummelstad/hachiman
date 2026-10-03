/**
 * GET /api/v1/kt/consistency?from=&to= → KtConsistencyProof (RFC 6962 §2.1.2, §12.14).
 */
import { consistencyProof } from '@/lib/mls/kt'
import { dsRoute, json } from '@/lib/mls/route'

export const GET = dsRoute('none', async (ctx) => json(await consistencyProof(ctx.repo, (await ctx.deps()).ds, ctx.req.nextUrl.searchParams)))
