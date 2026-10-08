/**
 * PATCH  /api/v1/guilds/:id/members/:userId { nick?, roles?, mute?, deaf?, channelId? }
 *        nick: self → CHANGE_NICKNAME, other → MANAGE_NICKNAMES;
 *        roles: MANAGE_ROLES + hierarchy for every role added or removed.
 *        A roles change takes X-Hachiman-Signed-Action (member_roles, §12.16).
 *        mute → MUTE_MEMBERS, deaf → DEAFEN_MEMBERS, channelId (move, or null
 *        to disconnect) → MOVE_MEMBERS; on another member also the moderation
 *        rule (requireModeratable). channelId needs the member in voice in
 *        the guild (§6 "Voice moderation").
 * DELETE /api/v1/guilds/:id/members/:userId — kick: KICK_MEMBERS, not the
 *        owner, and (unless owner/admin) the target's top role must be below ours.
 * Both tell the DS in the same transaction (§12.18), and revoke the permanent
 * invites and the invites with history of users who lost ADMINISTRATOR (§4).
 */
import { and, eq, inArray } from 'drizzle-orm'
import { computeChannelPermissions, has, Permissions } from '@hachiman/client/permissions'
import type { Member } from '@hachiman/client/types'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { guildMembers, memberRoles } from '@/db/schema'
import { enforceAdminAction } from '@/lib/admin-actions'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import {
  actorDeviceId,
  isPrivileged,
  loadChannelAccess,
  loadGuildAccess,
  requireAbovePosition,
  requireModeratable,
  requirePermission,
  type GuildAccess,
} from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { loadMember, membershipChanged, membershipTransaction, MembershipTriggers, removeMember } from '@/lib/guilds'
import { publishInviteDeletes, revokeAdminInvitesOfNonAdmins, type RevokedInvite } from '@/lib/invite-limits'
import { publishVoiceMove, readVoiceState } from '@/lib/voice-moderation'
import { toOverwrite } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string; userId: string }>
}

const updateMemberSchema = z.object({
  nick: z.string().trim().max(32).nullable().optional(),
  roles: z.array(z.string().uuid()).max(250).optional(),
  mute: z.boolean().optional(),
  deaf: z.boolean().optional(),
  channelId: z.string().uuid().nullable().optional(),
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

    if (body.mute !== undefined) requirePermission(access.permissions, Permissions.MUTE_MEMBERS)
    if (body.deaf !== undefined) requirePermission(access.permissions, Permissions.DEAFEN_MEMBERS)
    if (body.channelId !== undefined) requirePermission(access.permissions, Permissions.MOVE_MEMBERS)
    const voiceChange = body.mute !== undefined || body.deaf !== undefined || body.channelId !== undefined
    if (voiceChange && !isSelf) requireModeratable(access, userId, target)
    if (body.channelId !== undefined) await checkMove(access, session.user.id, target, body.channelId)

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

    const actor = await actorDeviceId(req, session.user.id)
    const revoked = await membershipTransaction(async (tx) => {
      if (body.roles !== undefined) {
        await enforceAdminAction(tx, req, { guildId: id, ownerId: access.guild.ownerId, userId: session.user.id }, {
          type: 7,
          userId,
          roleIds: [...new Set(body.roles)],
        })
      }
      const columns = {
        ...(body.nick !== undefined ? { nick: body.nick || null } : {}),
        ...(body.mute !== undefined ? { mute: body.mute } : {}),
        ...(body.deaf !== undefined ? { deaf: body.deaf } : {}),
      }
      if (Object.keys(columns).length > 0) {
        await tx
          .update(guildMembers)
          .set(columns)
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
      // Only a removed role can take ADMINISTRATOR away.
      const revoked: RevokedInvite[] = toRemove.length > 0 ? await revokeAdminInvitesOfNonAdmins(tx, id) : []
      if (toAdd.length > 0 || toRemove.length > 0) {
        await membershipChanged(tx, MembershipTriggers.memberRolesEdited(id, userId), actor)
      }
      return revoked
    })

    // Before the reload: a kick after the commit makes loadMember throw.
    await publishInviteDeletes(id, revoked)
    const member = await loadMember(id, userId)
    await publishToGuild(id, 'GUILD_MEMBER_UPDATE', member)
    if (body.channelId !== undefined) await publishVoiceMove(userId, id, body.channelId)
    return NextResponse.json(member)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, userId: rawUserId } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    const userId = assertId(rawUserId, 'member')
    requirePermission(access.permissions, Permissions.KICK_MEMBERS)
    if (userId === session.user.id) {
      throw new ValidationError('Use DELETE /users/@me/guilds/:id to leave')
    }
    requireModeratable(access, userId, await loadMember(id, userId))
    await removeMember(id, userId, await actorDeviceId(req, session.user.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * A move needs the member in voice in this guild, and a voice channel of the
 * guild that the caller and the member can both view and connect to.
 */
async function checkMove(access: GuildAccess, me: string, target: Member, channelId: string | null): Promise<void> {
  if (!(await readVoiceState(access.guild.id, target.user.id))) {
    throw new ValidationError('The member is not connected to voice')
  }
  if (channelId === null) return
  const dest = await loadChannelAccess(channelId, me)
  if (dest.channel.guildId !== access.guild.id || dest.channel.type !== 'voice') {
    throw new ValidationError('Not a voice channel of this guild')
  }
  requirePermission(dest.permissions, Permissions.CONNECT)
  const theirs = computeChannelPermissions(access.guild, target, access.roles, {
    permissionOverwrites: dest.overwrites.map(toOverwrite),
  })
  if (!has(theirs, Permissions.VIEW_CHANNEL | Permissions.CONNECT)) {
    throw new ValidationError('The member cannot connect to that channel')
  }
}
