/**
 * POST /api/v1/pages/:pageId/snapshots { baseSeq, uploadId, envelope,
 *      mediaUploadIds } + X-Hachiman-Device — SEND_MESSAGES. Compare-and-set
 *      on baseSeq (409 SnapshotConflict {baseSeq}), claims the
 *      ?kind=page_snapshot blob, keeps the previous snapshot and deletes the
 *      older ones. The baseSeq and uploadId of the newest snapshot in a newer
 *      epoch is a re-wrap of its pointer: no claim (§4 Pages).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { docsTransaction, loadPage } from '@/lib/docs/access'
import { docsLimits } from '@/lib/docs/config'
import { postSnapshot } from '@/lib/docs/service'
import { postSnapshotSchema, toDocSnapshot } from '@/lib/docs/wire'
import { requireDevice } from '@/lib/mls/device-auth'
import { deleteObjects } from '@/lib/storage'

interface RouteContext {
  params: Promise<{ pageId: string }>
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    const { pageId } = await ctx.params
    const { page, access } = await loadPage(pageId, userId, 'write')
    const device = await requireDevice(req, userId)
    const body = await parseBody(req, postSnapshotSchema)
    const limits = docsLimits()
    const { snapshot, keys } = await docsTransaction((repo, accept) =>
      postSnapshot(repo, accept, { page, guildId: access.guildId, userId, deviceId: device.id, body, limits }),
    )
    await deleteObjects(keys)
    return NextResponse.json(toDocSnapshot(snapshot), { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
