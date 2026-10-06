/**
 * GET  /api/v1/guilds/:id/invites — active (non-revoked) invites, permanent
 *      first, then newest first; MANAGE_GUILD.
 * POST /api/v1/guilds/:id/invites { maxAgeSeconds?, maxUses?, acknowledgedPermanent? }
 *      — CREATE_INSTANT_INVITE. Default 24 h, unlimited uses; maxUses 0 means
 *      unlimited. Without ADMINISTRATOR: 1–86400 s, else 403. ADMINISTRATOR:
 *      up to 7 days, or 0 (permanent) with acknowledgedPermanent: true, else 400.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { invites } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { isPrivileged, loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { assertInviteLimits, MAX_INVITE_AGE_S, MAX_LIMITED_INVITE_AGE_S } from '@/lib/invite-limits'
import { createInvite, createPermanentInvite } from '@/lib/invites'
import { toInvite } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const createInviteSchema = z.object({
  maxAgeSeconds: z.number().int().min(0).max(MAX_INVITE_AGE_S).default(MAX_LIMITED_INVITE_AGE_S),
  maxUses: z.number().int().min(0).max(100).default(0),
  acknowledgedPermanent: z.boolean().optional(),
})

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_GUILD)
    const rows = await db
      .select()
      .from(invites)
      .where(and(eq(invites.guildId, id), eq(invites.revoked, false)))
      .orderBy(desc(isNull(invites.expiresAt)), desc(invites.createdAt))
    return NextResponse.json(rows.map(toInvite))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.CREATE_INSTANT_INVITE)
    const body = await parseBody(req, createInviteSchema)
    assertInviteLimits(body, isPrivileged(access))
    const maxUses = body.maxUses > 0 ? body.maxUses : null
    const row =
      body.maxAgeSeconds === 0
        ? await createPermanentInvite({ guildId: id, createdBy: session.user.id, maxUses })
        : await createInvite({
            guildId: id,
            createdBy: session.user.id,
            expiresAt: new Date(Date.now() + body.maxAgeSeconds * 1000),
            maxUses,
          })
    return NextResponse.json(toInvite(row))
  } catch (err) {
    return errorResponse(err)
  }
}
