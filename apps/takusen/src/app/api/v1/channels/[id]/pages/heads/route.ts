/**
 * GET /api/v1/channels/:id/pages/heads — per page of a pages channel: latest_seq,
 *     the group and epoch of the title envelope and the newest snapshot;
 *     VIEW_CHANNEL. A re-wrap pass reads it instead of each page state (§4 Pages,
 *     §12.20 "Access by new members").
 */
import type { PageHead } from '@hachiman/client/types'
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadPagesChannel } from '@/lib/docs/access'
import { drizzleDocsRepo } from '@/lib/docs/repo.drizzle'
import { listPageHeads } from '@/lib/docs/service'
import { toPageHead } from '@/lib/docs/wire'
import { getDsModule } from '@/lib/mls/crypto'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadPagesChannel(id, session.user.id, 'read')
    const heads = await listPageHeads(drizzleDocsRepo(), await getDsModule(), id)
    const out: PageHead[] = heads.map(toPageHead)
    return NextResponse.json(out)
  } catch (err) {
    return errorResponse(err)
  }
}
