/**
 * PUT    /api/v1/channels/:id/permissions/:targetId { type, allow, deny } — MANAGE_ROLES.
 * DELETE /api/v1/channels/:id/permissions/:targetId — MANAGE_ROLES.
 * `targetId` is a role of the channel's guild (type 'role') or a member (type 'member').
 */
import { and, eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { type NextRequest, type NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { guildMembers, permissionOverwrites } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import {
  loadChannelAccess,
  publishToChannel,
  requireGrantable,
  requirePermission,
  type ChannelAccess,
  type GuildAccess,
} from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { permissionsSchema } from '@/lib/guild-schemas'
import { loadChannel } from '@/lib/guilds'

interface RouteContext {
  params: Promise<{ id: string; targetId: string }>
}

const overwriteSchema = z.object({
  type: z.enum(['role', 'member']),
  allow: permissionsSchema,
  deny: permissionsSchema,
})

async function manageOverwrites(
  ctx: RouteContext,
  userId: string,
): Promise<{ access: ChannelAccess; guild: GuildAccess; targetId: string }> {
  const { id, targetId } = await ctx.params
  const access = await loadChannelAccess(id, userId)
  if (!access.guild) throw new MissingPermissionsError('DM channels have no overwrites')
  requirePermission(access.permissions, Permissions.MANAGE_ROLES)
  return { access, guild: access.guild, targetId: assertId(targetId, 'overwrite target') }
}

export async function PUT(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { access, guild, targetId } = await manageOverwrites(ctx, session.user.id)
    const { type, allow, deny } = await parseBody(req, overwriteSchema)
    requireGrantable(guild, allow | deny)

    if (type === 'role' && !guild.roles.has(targetId)) throw new ValidationError('Unknown role')
    if (type === 'member') {
      const [member] = await db
        .select({ userId: guildMembers.userId })
        .from(guildMembers)
        .where(and(eq(guildMembers.guildId, guild.guild.id), eq(guildMembers.userId, targetId)))
        .limit(1)
      if (!member) throw new ValidationError('Unknown member')
    }

    await db
      .insert(permissionOverwrites)
      .values({ channelId: access.channel.id, targetId, targetType: type, allow, deny })
      .onConflictDoUpdate({
        target: [permissionOverwrites.channelId, permissionOverwrites.targetId],
        set: { targetType: type, allow, deny },
      })
    await publishToChannel(access, 'CHANNEL_UPDATE', await loadChannel(access.channel.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { access, targetId } = await manageOverwrites(ctx, session.user.id)
    await db
      .delete(permissionOverwrites)
      .where(
        and(
          eq(permissionOverwrites.channelId, access.channel.id),
          eq(permissionOverwrites.targetId, targetId),
        ),
      )
    await publishToChannel(access, 'CHANNEL_UPDATE', await loadChannel(access.channel.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
