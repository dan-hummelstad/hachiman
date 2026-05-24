/**
 * PUT    /api/me/servers/[id] — patch name or lastUsedAt on a user-server row.
 * DELETE /api/me/servers/[id] — remove from the user's list (204).
 *
 * Both 404 if the row isn't owned by the session user — we filter on
 * (id, userId) inside the helper rather than fetching+checking, so a row
 * belonging to another user is indistinguishable from "doesn't exist".
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
    const { id } = await ctx.params
    const body = await req.json()
    const parsed = updateUserServerSchema.parse(body)
    const server = await updateUserServer(session.user.id, id, parsed)
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
    const { id } = await ctx.params
    await deleteUserServer(session.user.id, id)
    return new NextResponse(null, { status: 204 })
  } catch (err) {
    return errorResponse(err)
  }
}
