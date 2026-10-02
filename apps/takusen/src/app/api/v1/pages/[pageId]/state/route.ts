/**
 * GET /api/v1/pages/:pageId/state — the newest snapshot and the first 500
 * updates after its baseSeq; VIEW_CHANNEL (§4 Pages).
 */
import type { PageState } from '@hachiman/client/types'
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadPage } from '@/lib/docs/access'
import { drizzleDocsRepo } from '@/lib/docs/repo.drizzle'
import { getPageState } from '@/lib/docs/service'
import { toDocSnapshot, toDocUpdate } from '@/lib/docs/wire'

interface RouteContext {
  params: Promise<{ pageId: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { pageId } = await ctx.params
    const { page } = await loadPage(pageId, session.user.id, 'read')
    const state = await getPageState(drizzleDocsRepo(), page)
    const out: PageState = {
      snapshot: state.snapshot ? toDocSnapshot(state.snapshot) : null,
      updates: state.updates.map(toDocUpdate),
      latestSeq: state.latestSeq,
    }
    return NextResponse.json(out)
  } catch (err) {
    return errorResponse(err)
  }
}
