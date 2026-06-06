/**
 * POST /api/servers/[id]/invites/[code]/revoke — revoke an invite.
 */
import { NextResponse, type NextRequest } from 'next/server'

import { requireUser } from '@/lib/auth-helpers'
import { errorResponse } from '@/lib/api-helpers'
import {
  InviteNotFoundError,
  getInviteByCode,
  revokeInvite,
} from '@/lib/invite-signing'
import { assertOwner } from '@/lib/servers'

interface RouteContext {
  params: Promise<{ id: string; code: string }>
}

export async function POST(
  _req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, code } = await ctx.params
    await assertOwner(id, session.user.id)
    const invite = await getInviteByCode(code)
    if (!invite || invite.virtualServerId !== id) {
      throw new InviteNotFoundError()
    }
    await revokeInvite(invite.id, id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
