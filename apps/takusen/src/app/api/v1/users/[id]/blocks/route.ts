/**
 * GET /api/v1/users/@me/blocks — BlockedUser[] { user, createdAt }, newest first.
 */
import { desc, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { userBlocks, users } from '@/db/schema'
import { errorResponse, requireMe } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { userColumns } from '@/lib/guilds'
import { toUser } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    requireMe((await ctx.params).id)
    const rows = await db
      .select({ user: userColumns, createdAt: userBlocks.createdAt })
      .from(userBlocks)
      .innerJoin(users, eq(users.id, userBlocks.blockedUserId))
      .where(eq(userBlocks.userId, session.user.id))
      .orderBy(desc(userBlocks.createdAt))
    return NextResponse.json(rows.map((r) => ({ user: toUser(r.user), createdAt: r.createdAt.toISOString() })))
  } catch (err) {
    return errorResponse(err)
  }
}
