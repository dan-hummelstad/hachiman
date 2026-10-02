/**
 * PATCH  /api/v1/guilds/:id/members/:userId { nick?, roles? }
 *        nick: self → CHANGE_NICKNAME, other → MANAGE_NICKNAMES;
 *        roles: MANAGE_ROLES + hierarchy for every role added or removed.
 * DELETE /api/v1/guilds/:id/members/:userId — kick: KICK_MEMBERS, not the
 *        owner, and (unless owner/admin) the target's top role must be below ours.
 */
import { and, eq, inArray } from 'drizzle-orm'
import { highestRolePosition, Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { guildMembers, memberRoles } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import {
  assertId,
  isPrivileged,
  loadGuildAccess,
  requireAbovePosition,
  requirePermission,
} from '@/lib/guild-access'
import { loadMember, removeMember } from '@/lib/guilds'

interface RouteContext {
  params: Promise<{ id: string; userId: string }>
}

const updateMemberSchema = z.object({
  nick: z.string().trim().max(32).nullable().optional(),
  roles: z.array(z.string().uuid()).max(250).optional(),
})

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, userId: rawUserId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    const userId = assertId(rawUserId, 'member')
    const body = await parseBody(req, updateMemberSchema)
    const target = await loadMember(id, userId)
    const isSelf = userId === session.user.id

    if (body.nick !== undefined) {
      requirePermission(
        access.permissions,
        isSelf ? Permissions.CHANGE_NICKNAME : Permissions.MANAGE_NICKNAMES,
      )
      if (!isSelf && userId === access.guild.ownerId && !isPrivileged(access)) {
        throw new MissingPermissionsError("Cannot change the owner's nickname")
      }
    }

    let toAdd: string[] = []
    let toRemove: string[] = []
    if (body.roles !== undefined) {
      requirePermission(access.permissions, Permissions.MANAGE_ROLES)
      const wanted = new Set(body.roles)
      if (wanted.has(id)) throw new ValidationError('@everyone is implicit and cannot be assigned')
      for (const roleId of wanted) {
        if (!access.roles.has(roleId)) throw new ValidationError(`Unknown role ${roleId}`)
      }
      toAdd = [...wanted].filter((r) => !target.roles.includes(r))
      toRemove = target.roles.filter((r) => !wanted.has(r))
      for (const roleId of [...toAdd, ...toRemove]) {
        requireAbovePosition(access, access.roles.get(roleId)?.position ?? 0)
      }
    }

    await db.transaction(async (tx) => {
      if (body.nick !== undefined) {
        await tx
          .update(guildMembers)
          .set({ nick: body.nick || null })
          .where(and(eq(guildMembers.guildId, id), eq(guildMembers.userId, userId)))
      }
      if (toRemove.length > 0) {
        await tx
          .delete(memberRoles)
          .where(and(eq(memberRoles.userId, userId), inArray(memberRoles.roleId, toRemove)))
      }
      if (toAdd.length > 0) {
        await tx.insert(memberRoles).values(toAdd.map((roleId) => ({ guildId: id, userId, roleId })))
      }
    })

    const member = await loadMember(id, userId)
    await publishToGuild(id, 'GUILD_MEMBER_UPDATE', member)
    return NextResponse.json(member)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, userId: rawUserId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    const userId = assertId(rawUserId, 'member')
    requirePermission(access.permissions, Permissions.KICK_MEMBERS)
    if (userId === access.guild.ownerId) throw new MissingPermissionsError('Cannot kick the owner')
    if (userId === session.user.id) {
      throw new ValidationError('Use DELETE /users/@me/guilds/:id to leave')
    }
    const target = await loadMember(id, userId)
    requireAbovePosition(access, highestRolePosition(target, access.roles))
    await removeMember(id, userId)
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
