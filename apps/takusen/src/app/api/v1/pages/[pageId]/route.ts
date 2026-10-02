/**
 * PATCH  /api/v1/pages/:pageId { parentId?, position?, titleEnvelope? } +
 *        X-Hachiman-Device — SEND_MESSAGES. A move into the own subtree is
 *        400 PageCycle (§4 Pages).
 * DELETE /api/v1/pages/:pageId — SEND_MESSAGES. Deletes the subtree and the
 *        page uploads (rows in the transaction, objects after commit).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadPage } from '@/lib/docs/access'
import { drizzleDocsRepo } from '@/lib/docs/repo.drizzle'
import { deletePage, updatePage } from '@/lib/docs/service'
import { toPage, updatePageSchema } from '@/lib/docs/wire'
import { publishToChannel } from '@/lib/guild-access'
import { requireDevice } from '@/lib/mls/device-auth'
import { acceptDocEnvelope } from '@/lib/mls/envelopes'
import { deleteObjects } from '@/lib/storage'

interface RouteContext {
  params: Promise<{ pageId: string }>
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    const { pageId } = await ctx.params
    const { page, access } = await loadPage(pageId, userId, 'write')
    const device = await requireDevice(req, userId)
    const body = await parseBody(req, updatePageSchema)
    const row = await db.transaction((tx) =>
      updatePage(drizzleDocsRepo(tx), (input) => acceptDocEnvelope(tx, input), { page, userId, deviceId: device.id, body, now: new Date() }),
    )
    const out = toPage(row)
    await publishToChannel(access, 'PAGE_UPDATE', { ...out, guildId: access.guildId })
    return NextResponse.json(out)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { pageId } = await ctx.params
    const { page, access } = await loadPage(pageId, session.user.id, 'write')
    const { ids, keys } = await db.transaction((tx) => deletePage(drizzleDocsRepo(tx), page))
    await deleteObjects(keys)
    await publishToChannel(access, 'PAGE_DELETE', { id: page.id, channelId: page.channelId, guildId: access.guildId, ids })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
