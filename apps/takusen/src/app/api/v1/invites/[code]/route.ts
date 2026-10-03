/**
 * GET    /api/v1/invites/:code — PUBLIC, non-consuming InvitePreview
 *        (404 unknown, 410 expired / revoked / exhausted).
 * POST   /api/v1/invites/:code — accept: join the guild and return its
 *        GuildFull. Idempotent for existing members (no use consumed, no events).
 * DELETE /api/v1/invites/:code — revoke; MANAGE_GUILD on the invite's guild.
 */
import { eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { invites } from '@/db/schema'
import { errorResponse, noContent } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { NotFoundError } from '@/lib/errors'
import { publishToGuild, publishToUser } from '@/lib/events'
import { actorDeviceId, loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { loadGuildFull, loadMember } from '@/lib/guilds'
import { acceptInvite, getInviteByCode, previewInvite } from '@/lib/invites'

interface RouteContext {
  params: Promise<{ code: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { code } = await ctx.params
    return NextResponse.json(await previewInvite(code))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const me = session.user.id
    const { code } = await ctx.params
    const { guildId, joined } = await acceptInvite(code, me, await actorDeviceId(req, me))
    const full = await loadGuildFull(guildId, me)
    if (joined) {
      await publishToGuild(guildId, 'GUILD_MEMBER_ADD', await loadMember(guildId, me))
      await publishToUser(me, 'GUILD_CREATE', full)
    }
    return NextResponse.json(full)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { code } = await ctx.params
    const invite = await getInviteByCode(code)
    if (!invite) throw new NotFoundError('Unknown invite')
    const access = await loadGuildAccess(invite.guildId, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_GUILD)
    await db.update(invites).set({ revoked: true }).where(eq(invites.id, invite.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
