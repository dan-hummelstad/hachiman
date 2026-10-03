/**
 * GET  /api/v1/pages/:pageId/updates?after=&limit= — updates with seq > after,
 *      ascending; VIEW_CHANNEL. limit is at most 500 (default 200).
 * POST /api/v1/pages/:pageId/updates { envelope } + X-Hachiman-Device —
 *      SEND_MESSAGES. Takes the next seq of the page, then publishes
 *      DOC_UPDATE after commit (§4 Pages).
 */
import type { DocUpdatePage } from '@hachiman/client/types'
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { docsTransaction, loadPage } from '@/lib/docs/access'
import { drizzleDocsRepo } from '@/lib/docs/repo.drizzle'
import { listUpdates, postUpdate } from '@/lib/docs/service'
import { parseUpdatesQuery, postUpdateSchema, toDocUpdate } from '@/lib/docs/wire'
import { publishToChannel } from '@/lib/guild-access'
import { requireDevice } from '@/lib/mls/device-auth'

interface RouteContext {
  params: Promise<{ pageId: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { pageId } = await ctx.params
    const { page } = await loadPage(pageId, session.user.id, 'read')
    const result = await listUpdates(drizzleDocsRepo(), page, parseUpdatesQuery(req.nextUrl.searchParams))
    const out: DocUpdatePage = { updates: result.updates.map(toDocUpdate), latestSeq: result.latestSeq }
    return NextResponse.json(out)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    const { pageId } = await ctx.params
    const { page, access } = await loadPage(pageId, userId, 'write')
    const device = await requireDevice(req, userId)
    const { envelope } = await parseBody(req, postUpdateSchema)
    const row = await docsTransaction((repo, accept) => postUpdate(repo, accept, { page, userId, deviceId: device.id, envelope }))
    await publishToChannel(access, 'DOC_UPDATE', { ...toDocUpdate(row), channelId: page.channelId, guildId: access.guildId })
    return NextResponse.json({ seq: row.seq }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
