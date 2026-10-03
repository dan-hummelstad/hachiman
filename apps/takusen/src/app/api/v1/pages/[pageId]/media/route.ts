/**
 * POST /api/v1/pages/:pageId/media { uploadIds } — SEND_MESSAGES. Claims
 * ?kind=blob uploads as page media, or refreshes a claim of this page. New
 * claims count against the guild page quota (413 StorageQuotaExceeded, §4 Pages).
 */
import { type NextRequest, type NextResponse } from 'next/server'

import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { docsTransaction, loadPage } from '@/lib/docs/access'
import { docsLimits } from '@/lib/docs/config'
import { claimMedia } from '@/lib/docs/service'
import { claimMediaSchema } from '@/lib/docs/wire'

interface RouteContext {
  params: Promise<{ pageId: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    const { pageId } = await ctx.params
    const { page, access } = await loadPage(pageId, userId, 'write')
    const { uploadIds } = await parseBody(req, claimMediaSchema)
    const limits = docsLimits()
    await docsTransaction((repo) => claimMedia(repo, { page, guildId: access.guildId, userId, uploadIds, now: new Date(), limits }))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
