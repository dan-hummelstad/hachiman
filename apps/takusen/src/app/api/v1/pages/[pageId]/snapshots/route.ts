/**
 * POST /api/v1/pages/:pageId/snapshots { baseSeq, uploadId, envelope,
 *      mediaUploadIds } + X-Hachiman-Device — SEND_MESSAGES. Compare-and-set
 *      on baseSeq (409 SnapshotConflict {baseSeq}), claims the
 *      ?kind=page_snapshot blob, keeps the previous snapshot and deletes the
 *      older ones (§4 Pages).
 */
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadPage } from '@/lib/docs/access'
import { docsLimits } from '@/lib/docs/config'
import { drizzleDocsRepo } from '@/lib/docs/repo.drizzle'
import { postSnapshot } from '@/lib/docs/service'
import { postSnapshotSchema, toDocSnapshot } from '@/lib/docs/wire'
import { requireDevice } from '@/lib/mls/device-auth'
import { acceptDocEnvelope } from '@/lib/mls/envelopes'
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
    const { snapshot, keys } = await db.transaction((tx) =>
      postSnapshot(drizzleDocsRepo(tx), (input) => acceptDocEnvelope(tx, input), {
        page,
        guildId: access.guildId,
        userId,
        deviceId: device.id,
        body,
        limits,
      }),
    )
    await deleteObjects(keys)
    return NextResponse.json(toDocSnapshot(snapshot), { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
