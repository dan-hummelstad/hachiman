/**
 * PUT    /api/v1/channels/:id/permissions/:targetId { type, allow, deny } — MANAGE_ROLES.
 * DELETE /api/v1/channels/:id/permissions/:targetId — MANAGE_ROLES.
 * Not on a thread: it has the overwrites of its parent (400).
 * `targetId` is a role of the channel's guild (type 'role') or a member (type 'member').
 * Both take X-Hachiman-Signed-Action (overwrite_put / overwrite_delete, §12.16)
 * and tell the DS in the same transaction (`overwrites_changed`, §12.18): the
 * channel can move between the public_set group and its own group (§12.6).
 */
import { and, eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { type NextRequest, type NextResponse } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { guildMembers, permissionOverwrites } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { enforceAdminAction } from '@/lib/admin-actions'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import {
  actorDeviceId,
  loadChannelAccess,
  publishToChannel,
  requireGrantable,
  requirePermission,
  type ChannelAccess,
  type GuildAccess,
} from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { permissionsSchema } from '@/lib/guild-schemas'
import { loadChannel, membershipChanged, membershipTransaction, MembershipTriggers } from '@/lib/guilds'

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
  if (access.channel.type === 'thread') throw new ValidationError('A thread has the overwrites of its parent')
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

    const actor = await actorDeviceId(req, session.user.id)
    const channelId = access.channel.id
    await membershipTransaction(async (tx) => {
      await enforceAdminAction(tx, req, { guildId: guild.guild.id, ownerId: guild.guild.ownerId, userId: session.user.id }, {
        type: 5,
        channelId,
        targetId,
        targetType: type,
        allow,
        deny,
      })
      await tx
        .insert(permissionOverwrites)
        .values({ channelId, targetId, targetType: type, allow, deny })
        .onConflictDoUpdate({
          target: [permissionOverwrites.channelId, permissionOverwrites.targetId],
          set: { targetType: type, allow, deny },
        })
      await membershipChanged(tx, MembershipTriggers.overwritesChanged(channelId), actor)
    })
    await publishToChannel(access, 'CHANNEL_UPDATE', await loadChannel(access.channel.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { access, guild, targetId } = await manageOverwrites(ctx, session.user.id)
    const actor = await actorDeviceId(req, session.user.id)
    const channelId = access.channel.id
    const existing = access.overwrites.find((o) => o.targetId === targetId)
    await membershipTransaction(async (tx) => {
      await enforceAdminAction(tx, req, { guildId: guild.guild.id, ownerId: guild.guild.ownerId, userId: session.user.id }, {
        type: 6,
        channelId,
        targetId,
        targetType: existing?.targetType ?? (guild.roles.has(targetId) ? 'role' : 'member'),
      })
      await tx
        .delete(permissionOverwrites)
        .where(and(eq(permissionOverwrites.channelId, channelId), eq(permissionOverwrites.targetId, targetId)))
      await membershipChanged(tx, MembershipTriggers.overwritesChanged(channelId), actor)
    })
    await publishToChannel(access, 'CHANNEL_UPDATE', await loadChannel(access.channel.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
