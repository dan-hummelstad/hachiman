/**
 * GET /api/v1/kt/entries?userId=&after=&limit= — the entries of one user (limit ≤ 1000).
 * GET /api/v1/kt/entries?start=&end= — a range, for auditors (at most 1000) (§12.14).
 */
import { listEntries } from '@/lib/mls/kt'
import { dsRoute, json } from '@/lib/mls/route'

export const GET = dsRoute('none', async (ctx) => json(await listEntries(ctx.repo, ctx.req.nextUrl.searchParams)))
