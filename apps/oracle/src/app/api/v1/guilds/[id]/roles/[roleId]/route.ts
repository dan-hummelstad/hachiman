/**
 * PATCH  /api/v1/guilds/:id/roles/:roleId { name?, color?, permissions? } — MANAGE_ROLES + hierarchy.
 * DELETE /api/v1/guilds/:id/roles/:roleId — MANAGE_ROLES + hierarchy; never @everyone.
 */
import { and, eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { permissionOverwrites, roles } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import {
  loadGuildAccess,
  requireAbovePosition,
  requireGrantable,
  requirePermission,
  type GuildAccess,
} from '@/lib/guild-access'
import { colorSchema, nameSchema, permissionsSchema } from '@/lib/guild-schemas'
import { loadChannels } from '@/lib/guilds'
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

    const [row] =
      Object.keys(body).length > 0
        ? await db
            .update(roles)
            .set(body)
            .where(and(eq(roles.id, roleId), eq(roles.guildId, id)))
            .returning()
        : [current]
    const role = toRole(row)
    await publishToGuild(id, 'GUILD_ROLE_UPDATE', { guildId: id, role })
    return NextResponse.json(role)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, roleId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    manageableRole(access, roleId)
    if (roleId === id) throw new ValidationError('@everyone cannot be deleted')

    // Overwrites target roles polymorphically (no FK), so clear them here.
    const touched = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(permissionOverwrites)
        .where(eq(permissionOverwrites.targetId, roleId))
        .returning({ channelId: permissionOverwrites.channelId })
      await tx.delete(roles).where(and(eq(roles.id, roleId), eq(roles.guildId, id)))
      return rows.map((r) => r.channelId)
    })

    await publishToGuild(id, 'GUILD_ROLE_DELETE', { guildId: id, roleId })
    for (const channel of await loadChannels(touched)) {
      await publishToGuild(id, 'CHANNEL_UPDATE', channel, channel.id)
    }
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
