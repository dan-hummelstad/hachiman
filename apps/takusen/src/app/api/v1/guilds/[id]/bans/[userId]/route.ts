/**
 * PUT    /api/v1/guilds/:id/bans/:userId { reason? } — ban: BAN_MEMBERS, not
 *        the owner or yourself, and a member target must be below the caller's
 *        top role. Removes the membership as a kick does (§12.18), in the same
 *        transaction as the ban row. Idempotent.
 * DELETE /api/v1/guilds/:id/bans/:userId — unban: BAN_MEMBERS. 404 without a ban.
 */
import { Permissions } from '@hachiman/client/permissions'
import { type NextRequest, type NextResponse } from 'next/server'
import { z } from 'zod'

import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { BAN_REASON_MAX, banUser, unbanUser } from '@/lib/bans'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { actorDeviceId, loadGuildAccess, requireModeratable, requirePermission } from '@/lib/guild-access'
import { loadMember } from '@/lib/guilds'
import { assertId } from '@/lib/ids'

interface RouteContext {
  params: Promise<{ id: string; userId: string }>
}

const banSchema = z.object({
  reason: z.string().trim().max(BAN_REASON_MAX).nullable().optional(),
})

export async function PUT(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, userId: rawUserId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    const userId = assertId(rawUserId, 'user')
    requirePermission(access.permissions, Permissions.BAN_MEMBERS)
    if (userId === session.user.id) throw new ValidationError('Cannot ban yourself')
    const body = await parseBody(req, banSchema)
    const target = await loadMember(id, userId).catch((err: unknown) => {
      if (err instanceof NotFoundError) return null // a ban by user id
      throw err
    })
    requireModeratable(access, userId, target)
    await banUser({
      guildId: id,
      userId,
      reason: body.reason || null,
      bannedBy: session.user.id,
      actorDeviceId: await actorDeviceId(req, session.user.id),
    })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, userId: rawUserId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    const userId = assertId(rawUserId, 'user')
    requirePermission(access.permissions, Permissions.BAN_MEMBERS)
    await unbanUser(id, userId)
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
