/**
 * PATCH  /api/v1/channels/:id { name?, topic?, parentId?, position?, historyVisibility? }
 *        — MANAGE_CHANNELS. A thread takes only `name`, from MANAGE_CHANNELS
 *        (on the parent) or the creator of the thread (§4 Threads). `historyVisibility` only for a channel with its own
 *        group (§12.6). It sets the value that REST mirrors. Members change the
 *        group descriptor with a GCE commit. In Phase 4 the change also takes
 *        X-Hachiman-Signed-Action (channel_history_visibility, §12.16).
 * DELETE /api/v1/channels/:id — MANAGE_CHANNELS, or the creator of a thread.
 *        The DS retires the channel's groups in the same transaction. Deletes
 *        the threads of the channel, the attachment rows of all their messages,
 *        then (best effort) their objects. CHANNEL_DELETE of each thread comes
 *        before the one of the channel.
 * A group DM (§4 DMs): PATCH takes `{ name?, icon? }` from any participant
 * (`icon` is an image upload id, or null). DELETE is for its owner only. A
 * 1:1 DM has neither.
 */
import { and, eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels, mlsGroups } from '@/db/schema'
import { enforceAdminAction } from '@/lib/admin-actions'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { asGroupDm, deleteGroupDm, updateGroupDm } from '@/lib/group-dm'
import {
  actorDeviceId,
  channelIsPublic,
  loadChannelAccess,
  publishToChannel,
  requirePermission,
  type ChannelAccess,
} from '@/lib/guild-access'
import { hasTextGroup, THREAD_PARENT_TYPE } from '@/lib/channel-types'
import { assertParent, historyVisibilitySchema, nameSchema } from '@/lib/guild-schemas'
import { loadChannel, membershipChanged, membershipTransaction, MembershipTriggers } from '@/lib/guilds'
import { deleteObjects } from '@/lib/storage'
import { canManageThread } from '@/lib/threads'
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

const updateGroupDmSchema = z.object({
  name: nameSchema.nullable().optional(),
  icon: z.string().uuid().nullable().optional(),
})

function assertManageable(access: ChannelAccess, userId: string): void {
  if (access.channel.type === 'thread') {
    if (!canManageThread(access.channel, userId, access.permissions)) throw new MissingPermissionsError()
  } else {
    requirePermission(access.permissions, Permissions.MANAGE_CHANNELS)
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    if (!access.guild) {
      const body = await parseBody(req, updateGroupDmSchema)
      return NextResponse.json(await updateGroupDm(asGroupDm(access), session.user.id, body))
    }
    assertManageable(access, session.user.id)
    const { historyVisibility, ...body } = await parseBody(req, updateChannelSchema)
    if (access.channel.type === 'thread' && (body.topic !== undefined || body.position !== undefined)) {
      throw new ValidationError('A thread takes only a name')
    }
    await assertParent(access.channel.guildId!, body.parentId, access.channel.type)

    // §12.6: only a private text or pages channel has its own group.
    let ownGroup: Uint8Array | null = null
    if (historyVisibility !== undefined) {
      const groupId = access.channel.mlsGroupId
      const [group] = groupId
        ? await db.select({ kind: mlsGroups.kind, status: mlsGroups.status }).from(mlsGroups).where(eq(mlsGroups.groupId, groupId)).limit(1)
        : []
      if (!hasTextGroup(access.channel.type) || (await channelIsPublic(id)) || group?.kind !== 'channel' || group.status === 'retired') {
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
    const access = await loadChannelAccess(id, session.user.id)
    const actor = await actorDeviceId(req, session.user.id)
    if (!access.guild) {
      await deleteGroupDm(asGroupDm(access), session.user.id, actor)
      return noContent()
    }
    assertManageable(access, session.user.id)
    const { keys, threads } = await membershipTransaction(async (tx) => {
      // Lock the channel first: a thread insert key-share-locks its parent, so
      // no thread can appear after the select below. Without the lock it would
      // lose its parent to ON DELETE SET NULL and become an orphan.
      await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, id)).for('update')
      const isThread = and(eq(channels.parentId, id), eq(channels.type, 'thread'))
      const threads = access.channel.type === THREAD_PARENT_TYPE ? await tx.select().from(channels).where(isThread) : []
      const keys = await deleteAttachmentRows(tx, { channelIds: [...threads.map((t) => t.id), id] })
      if (threads.length > 0) await tx.delete(channels).where(isThread)
      await membershipChanged(tx, MembershipTriggers.channelDeleted(access.channel.guildId!, id), actor)
      await tx.delete(channels).where(eq(channels.id, id))
      return { keys, threads }
    })
    await deleteObjects(keys)
    for (const t of threads) await publishToChannel({ channel: t, participantIds: [] }, 'CHANNEL_DELETE', toChannel(t, []))
    await publishToChannel(access, 'CHANNEL_DELETE', toChannel(access.channel, access.overwrites))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
