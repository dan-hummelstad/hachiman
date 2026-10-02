/**
 * GET   /api/v1/users/@me — the caller (the gateway resolves IDENTIFY tokens here).
 *       With X-Hachiman-Device, the device must be the device of the token
 *       (requireDevice: owner, not revoked, device binding); else 403.
 * GET   /api/v1/users/:id — any user, by id.
 * PATCH /api/v1/users/@me { avatar?: uploadId | null } — USER_UPDATE to the
 *       caller, and GUILD_MEMBER_UPDATE with the full Member to each of its
 *       guilds (the gateway replaces the member's roles from that payload).
 */
import { eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { users } from '@/db/schema'
import { errorResponse, isMe, parseBody, requireMe } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { NotFoundError } from '@/lib/errors'
import { assertId } from '@/lib/ids'
import { getUserById, publishUserUpdate } from '@/lib/guilds'
import { DEVICE_HEADER, requireDevice } from '@/lib/mls/device-auth'
import { claimImage } from '@/lib/uploads'
import { toUser } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const updateMeSchema = z.object({
  avatar: z.string().uuid().nullable().optional(),
})

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    if (isMe(id) && req.headers.get(DEVICE_HEADER)) await requireDevice(req, session.user.id, { allowPending: true })
    const userId = isMe(id) ? session.user.id : assertId(id, 'user')
    const user = await getUserById(userId)
    if (!user) throw new NotFoundError('Unknown user')
    return NextResponse.json(toUser(user))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    requireMe(id)
    const userId = session.user.id
    const { avatar } = await parseBody(req, updateMeSchema)

    if (avatar !== undefined) {
      await db.transaction(async (tx) => {
        const image = avatar === null ? null : await claimImage(tx, avatar, userId)
        await tx.update(users).set({ image, updatedAt: new Date() }).where(eq(users.id, userId))
      })
    }
    const row = await getUserById(userId)
    if (!row) throw new NotFoundError('Unknown user')
    const user = toUser(row)
    if (avatar !== undefined) await publishUserUpdate(user)
    return NextResponse.json(user)
  } catch (err) {
    return errorResponse(err)
  }
}
