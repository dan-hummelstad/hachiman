/**
 * PATCH  /api/v1/channels/:id { name?, topic?, parentId?, position? } — MANAGE_CHANNELS.
 * DELETE /api/v1/channels/:id — MANAGE_CHANNELS. Deletes its messages'
 *        attachment rows, then (best effort) their objects.
 * Guild channels only; DMs have no editable settings in v1.
 */
import { eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError } from '@/lib/errors'
import { loadChannelAccess, publishToChannel, requirePermission, type ChannelAccess } from '@/lib/guild-access'
import { assertParent, nameSchema } from '@/lib/guild-schemas'
import { loadChannel } from '@/lib/guilds'
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
    const body = await parseBody(req, updateChannelSchema)
    await assertParent(access.channel.guildId!, body.parentId, access.channel.type)

    if (Object.keys(body).length > 0) {
      await db.update(channels).set(body).where(eq(channels.id, id))
    }
    const channel = await loadChannel(id)
    await publishToChannel(access, 'CHANNEL_UPDATE', channel)
    return NextResponse.json(channel)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await manageableChannel(id, session.user.id)
    const keys = await db.transaction(async (tx) => {
      const keys = await deleteAttachmentRows(tx, { channelId: id })
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
