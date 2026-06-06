/**
 * PUT    /api/me/servers/[id] — patch name/lastUsedAt on the calling user's
 *                              row that points at canonical server `[id]`.
 * DELETE /api/me/servers/[id] — remove that row from the user's list (204).
 *
 * `[id]` is the canonical `servers.id` UUID (what the Hachiman client carries
 * around as `server.serverId`), NOT the `user_servers` row primary key. The
 * helper filters on (serverId, userId), so a row belonging to another user
 * is indistinguishable from "doesn't exist" — both return 404.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import {
  deleteUserServer,
  serializeUserServer,
  updateUserServer,
  updateUserServerSchema,
} from '@/lib/user-servers'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function PUT(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id: serverId } = await ctx.params
    const body = await req.json()
    const parsed = updateUserServerSchema.parse(body)
    const server = await updateUserServer(session.user.id, serverId, parsed)
    return NextResponse.json(serializeUserServer(server))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id: serverId } = await ctx.params
    await deleteUserServer(session.user.id, serverId)
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return errorResponse(err)
  }
}
