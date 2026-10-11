/**
 * PATCH  /api/v1/pages/:pageId { parentId?, position?, titleEnvelope?,
 *        banner?: { envelope, uploadIds? } | null, ifUpdatedAt? } +
 *        X-Hachiman-Device — SEND_MESSAGES. A move into the own subtree is
 *        400 PageCycle. An `ifUpdatedAt` that differs from the page `updatedAt`
 *        is 409 PageConflict. A banner is only on a top-level page; the PATCH
 *        claims its uploads as page media (413 StorageQuotaExceeded), and a
 *        move under a page clears it (§4 Pages "Banner").
 * DELETE /api/v1/pages/:pageId — SEND_MESSAGES. Deletes the subtree and the
 *        page uploads (rows in the transaction, objects after commit).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { docsTransaction, loadPage } from '@/lib/docs/access'
import { docsLimits } from '@/lib/docs/config'
import { deletePage, updatePage } from '@/lib/docs/service'
import { toPage, updatePageSchema } from '@/lib/docs/wire'
import { publishToChannel } from '@/lib/guild-access'
import { requireDevice } from '@/lib/mls/device-auth'
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
    const limits = docsLimits()
    const row = await docsTransaction((repo, accept) =>
      updatePage(repo, accept, { page, guildId: access.guildId, userId, deviceId: device.id, body, now: new Date(), limits }),
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
    const { ids, keys } = await docsTransaction((repo) => deletePage(repo, page))
    await deleteObjects(keys)
    await publishToChannel(access, 'PAGE_DELETE', { id: page.id, channelId: page.channelId, guildId: access.guildId, ids })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
