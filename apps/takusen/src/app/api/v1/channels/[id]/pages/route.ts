/**
 * GET  /api/v1/channels/:id/pages — every page of a pages channel; VIEW_CHANNEL.
 * POST /api/v1/channels/:id/pages { id, parentId, position, titleEnvelope } +
 *      X-Hachiman-Device — SEND_MESSAGES. The client chooses the id: the
 *      doc_title envelope binds it (§4 Pages, §12.20).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadPagesChannel } from '@/lib/docs/access'
import { drizzleDocsRepo } from '@/lib/docs/repo.drizzle'
import { createPage } from '@/lib/docs/service'
import { createPageSchema, toPage } from '@/lib/docs/wire'
import { publishToChannel } from '@/lib/guild-access'
import { requireDevice } from '@/lib/mls/device-auth'
import { acceptDocEnvelope } from '@/lib/mls/envelopes'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadPagesChannel(id, session.user.id, 'read')
    const rows = await drizzleDocsRepo().listPages(id)
    return NextResponse.json(rows.map(toPage))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    const { id } = await ctx.params
    const access = await loadPagesChannel(id, userId, 'write')
    const device = await requireDevice(req, userId)
    const body = await parseBody(req, createPageSchema)
    const row = await db.transaction((tx) =>
      createPage(drizzleDocsRepo(tx), (input) => acceptDocEnvelope(tx, input), { channelId: id, userId, deviceId: device.id, body }),
    )
    const page = toPage(row)
    await publishToChannel(access, 'PAGE_CREATE', { ...page, guildId: access.guildId })
    return NextResponse.json(page, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
