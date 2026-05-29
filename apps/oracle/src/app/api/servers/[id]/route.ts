/**
 * PATCH /api/servers/[id] — update name/description/region (slug and host
 * immutable; region is the mutable, re-selectable voice-placement property).
 * DELETE /api/servers/[id] — owner only.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import {
  assertOwner,
  deleteServer,
  updateServer,
  updateServerSchema,
} from '@/lib/servers'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function PATCH(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await assertOwner(id, session.user.id)
    const body = await req.json()
    const parsed = updateServerSchema.parse(body)
    const server = await updateServer(id, parsed)
    return NextResponse.json({ server })
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
    await assertOwner(id, session.user.id)
    await deleteServer(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
