/**
 * DELETE /api/v1/bots/:id — the owner deletes the bot user, as the admin user
 * delete does (contract §4 Bots, §4 Admin API). 404 for a bot of another user.
 */
import { type NextRequest, type NextResponse } from 'next/server'

import { errorResponse, noContent } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { deleteBot } from '@/lib/bot-accounts'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    await deleteBot(session.user.id, (await ctx.params).id)
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
