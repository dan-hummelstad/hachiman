/**
 * PATCH  /api/v1/guilds/:id/roles/:roleId { name?, color?, permissions? } — MANAGE_ROLES + hierarchy.
 * DELETE /api/v1/guilds/:id/roles/:roleId — MANAGE_ROLES + hierarchy; never @everyone.
 * A permissions change and a delete take X-Hachiman-Signed-Action (role_update /
 * role_delete, §12.16). Both tell the DS in the same transaction (§12.18), and
 * revoke the permanent invites of users who lost ADMINISTRATOR (§4).
 */
import { and, eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { permissionOverwrites, roles } from '@/db/schema'
import { enforceAdminAction } from '@/lib/admin-actions'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import {
  actorDeviceId,
  loadGuildAccess,
  requireAbovePosition,
  requireGrantable,
  requirePermission,
  type GuildAccess,
} from '@/lib/guild-access'
import { colorSchema, nameSchema, permissionsSchema } from '@/lib/guild-schemas'
import { loadChannels, membershipChanged, membershipTransaction, MembershipTriggers } from '@/lib/guilds'
import { publishInviteDeletes, revokePermanentInvitesOfNonAdmins, type RevokedInvite } from '@/lib/invite-limits'
import { toRole } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string; roleId: string }>
}

const updateRoleSchema = z.object({
  name: nameSchema.optional(),
  color: colorSchema.optional(),
  permissions: permissionsSchema.optional(),
})

function manageableRole(access: GuildAccess, roleId: string) {
  requirePermission(access.permissions, Permissions.MANAGE_ROLES)
  const role = access.roles.get(roleId)
  if (!role) throw new NotFoundError('Unknown role')
  requireAbovePosition(access, role.position)
  return role
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, roleId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    const current = manageableRole(access, roleId)
    const body = await parseBody(req, updateRoleSchema)
    if (roleId === id && body.name !== undefined) {
      throw new ValidationError('@everyone cannot be renamed')
    }
    // Only the bits being changed must be grantable, so a manager can still
    // edit a role that already holds permissions they lack.
    if (body.permissions !== undefined) requireGrantable(access, body.permissions ^ current.permissions)
    const actor = await actorDeviceId(req, session.user.id)

    const { row, revoked } = await membershipTransaction(async (tx) => {
      if (body.permissions !== undefined) {
        await enforceAdminAction(tx, req, { guildId: id, ownerId: access.guild.ownerId, userId: session.user.id }, {
          type: 2,
          roleId,
          permissions: body.permissions,
          position: current.position,
        })
      }
      if (Object.keys(body).length === 0) return { row: current, revoked: [] }
      const [updated] = await tx
        .update(roles)
        .set(body)
        .where(and(eq(roles.id, roleId), eq(roles.guildId, id)))
        .returning()
      let revoked: RevokedInvite[] = []
      if (body.permissions !== undefined) {
        // `current` was read before the transaction, so a concurrent grant can hide a demotion.
        revoked = await revokePermanentInvitesOfNonAdmins(tx, id)
        if (body.permissions !== current.permissions) {
          await membershipChanged(tx, MembershipTriggers.roleChanged(id, roleId), actor)
        }
      }
      return { row: updated!, revoked }
    })
    const role = toRole(row)
    await publishToGuild(id, 'GUILD_ROLE_UPDATE', { guildId: id, role })
    await publishInviteDeletes(id, revoked)
    return NextResponse.json(role)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, roleId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    manageableRole(access, roleId)
    if (roleId === id) throw new ValidationError('@everyone cannot be deleted')
    const actor = await actorDeviceId(req, session.user.id)

    // Overwrites target roles polymorphically (no FK), so clear them here.
    const { touched, revoked } = await membershipTransaction(async (tx) => {
      await enforceAdminAction(tx, req, { guildId: id, ownerId: access.guild.ownerId, userId: session.user.id }, { type: 3, roleId })
      const rows = await tx
        .delete(permissionOverwrites)
        .where(eq(permissionOverwrites.targetId, roleId))
        .returning({ channelId: permissionOverwrites.channelId })
      await tx.delete(roles).where(and(eq(roles.id, roleId), eq(roles.guildId, id)))
      const revoked = await revokePermanentInvitesOfNonAdmins(tx, id)
      await membershipChanged(tx, MembershipTriggers.roleDeleted(id, roleId), actor)
      return { touched: rows.map((r) => r.channelId), revoked }
    })

    await publishToGuild(id, 'GUILD_ROLE_DELETE', { guildId: id, roleId })
    for (const channel of await loadChannels(touched)) {
      await publishToGuild(id, 'CHANNEL_UPDATE', channel, channel.id)
    }
    await publishInviteDeletes(id, revoked)
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
