/**
 * GET  /api/v1/guilds/:id/invites — active (non-revoked) invites; MANAGE_GUILD.
 * POST /api/v1/guilds/:id/invites { maxAgeSeconds?, maxUses? } — CREATE_INSTANT_INVITE.
 *      Discord defaults: 24 h, unlimited uses; 0 means "never" / "unlimited".
 */
import { and, desc, eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { invites } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { createInvite } from '@/lib/invites'
import { toInvite } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const createInviteSchema = z.object({
  maxAgeSeconds: z.number().int().min(0).max(7 * 24 * 3600).default(24 * 3600),
  maxUses: z.number().int().min(0).max(100).default(0),
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
      .orderBy(desc(invites.createdAt))
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
    const { maxAgeSeconds, maxUses } = await parseBody(req, createInviteSchema)
    const row = await createInvite({
      guildId: id,
      createdBy: session.user.id,
      expiresAt: maxAgeSeconds > 0 ? new Date(Date.now() + maxAgeSeconds * 1000) : null,
      maxUses: maxUses > 0 ? maxUses : null,
    })
    return NextResponse.json(toInvite(row))
  } catch (err) {
    return errorResponse(err)
  }
}
