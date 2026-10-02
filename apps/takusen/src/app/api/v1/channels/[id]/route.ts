/**
 * PATCH  /api/v1/channels/:id { name?, topic?, parentId?, position?, historyVisibility? }
 *        — MANAGE_CHANNELS. `historyVisibility` only for a channel with its own
 *        group (§12.6). It sets the value that REST mirrors. Members change the
 *        group descriptor with a GCE commit. In Phase 4 the change also takes
 *        X-Hachiman-Signed-Action (channel_history_visibility, §12.16).
 * DELETE /api/v1/channels/:id — MANAGE_CHANNELS. The DS retires the channel's
 *        groups in the same transaction. Deletes its messages' attachment rows,
 *        then (best effort) their objects.
 * Guild channels only; DMs have no editable settings in v1.
 */
import { eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels, mlsGroups } from '@/db/schema'
import { enforceAdminAction } from '@/lib/admin-actions'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import {
  actorDeviceId,
  channelIsPublic,
  loadChannelAccess,
  publishToChannel,
  requirePermission,
  type ChannelAccess,
} from '@/lib/guild-access'
import { assertParent, historyVisibilitySchema, nameSchema } from '@/lib/guild-schemas'
import { loadChannel, membershipChanged, membershipTransaction, MembershipTriggers } from '@/lib/guilds'
import { deleteObjects } from '@/lib/storage'
import { deleteAttachmentRows } from '@/lib/uploads'
import { toChannel } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const updateChannelSchema = z.object({
  name: nameSchema.optional(),
  topic: z.string().max(1024).nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).optional(),
  historyVisibility: historyVisibilitySchema.optional(),
})

async function manageableChannel(channelId: string, userId: string): Promise<ChannelAccess> {
  const access = await loadChannelAccess(channelId, userId)
  if (!access.guild) throw new MissingPermissionsError('DM channels cannot be managed')
  requirePermission(access.permissions, Permissions.MANAGE_CHANNELS)
  return access
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await manageableChannel(id, session.user.id)
    const { historyVisibility, ...body } = await parseBody(req, updateChannelSchema)
    await assertParent(access.channel.guildId!, body.parentId, access.channel.type)

    // §12.6: only a private text channel has its own group.
    let ownGroup: Uint8Array | null = null
    if (historyVisibility !== undefined) {
      const groupId = access.channel.mlsGroupId
      const [group] = groupId
        ? await db.select({ kind: mlsGroups.kind, status: mlsGroups.status }).from(mlsGroups).where(eq(mlsGroups.groupId, groupId)).limit(1)
        : []
      if (access.channel.type !== 'text' || (await channelIsPublic(id)) || group?.kind !== 'channel' || group.status === 'retired') {
        throw new ValidationError('historyVisibility needs a channel with its own group')
      }
      ownGroup = groupId
    }

    const guild = access.guild!.guild
    await db.transaction(async (tx) => {
      if (historyVisibility !== undefined) {
        await enforceAdminAction(tx, req, { guildId: guild.id, ownerId: guild.ownerId, userId: session.user.id }, {
          type: 8,
          channelId: id,
          historyVisibility,
        })
        await tx.update(mlsGroups).set({ historyVisibility }).where(eq(mlsGroups.groupId, ownGroup!))
      }
      if (Object.keys(body).length > 0) await tx.update(channels).set(body).where(eq(channels.id, id))
    })
    const channel = await loadChannel(id)
    await publishToChannel(access, 'CHANNEL_UPDATE', channel)
    return NextResponse.json(channel)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await manageableChannel(id, session.user.id)
    const actor = await actorDeviceId(req, session.user.id)
    const keys = await membershipTransaction(async (tx) => {
      const keys = await deleteAttachmentRows(tx, { channelId: id })
      await membershipChanged(tx, MembershipTriggers.channelDeleted(access.channel.guildId!, id), actor)
      await tx.delete(channels).where(eq(channels.id, id))
      return keys
    })
    await deleteObjects(keys)
    await publishToChannel(access, 'CHANNEL_DELETE', toChannel(access.channel, access.overwrites))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
