/**
 * PUT    /api/v1/users/@me/blocks/:userId — block a user. 400 for yourself,
 *        404 for an unknown user. 204.
 * DELETE /api/v1/users/@me/blocks/:userId — unblock. 204.
 * A change publishes USER_BLOCK_UPDATE { userId, blocked } to the caller's own
 * sessions only. The blocked user is not told. A repeated call publishes nothing.
 */
import { and, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { userBlocks } from '@/db/schema'
import { errorResponse, noContent, requireMe } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { publishToUser } from '@/lib/events'
import { requireUserById } from '@/lib/guilds'
import { assertId } from '@/lib/ids'

interface RouteContext {
  params: Promise<{ id: string; userId: string }>
}

async function load(ctx: RouteContext): Promise<{ me: string; target: string }> {
  const session = await requireUser()
  const { id, userId } = await ctx.params
  requireMe(id)
  assertId(userId, 'user')
  return { me: session.user.id, target: userId }
}

export async function PUT(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { me, target } = await load(ctx)
    if (target === me) throw new ValidationError('You cannot block yourself')
    await requireUserById(target)
    const added = await db
      .insert(userBlocks)
      .values({ userId: me, blockedUserId: target })
      .onConflictDoNothing()
      .returning()
    if (added.length > 0) await publishToUser(me, 'USER_BLOCK_UPDATE', { userId: target, blocked: true })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { me, target } = await load(ctx)
    const removed = await db
      .delete(userBlocks)
      .where(and(eq(userBlocks.userId, me), eq(userBlocks.blockedUserId, target)))
      .returning()
    if (removed.length > 0) await publishToUser(me, 'USER_BLOCK_UPDATE', { userId: target, blocked: false })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
