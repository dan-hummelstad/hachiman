/**
 * PATCH  /api/v1/channels/:id/messages/:mid { content } — author only.
 *        Attachments never change; content may be '' when there are some.
 * DELETE /api/v1/channels/:id/messages/:mid — author or MANAGE_MESSAGES.
 *        Deletes its upload rows, then (best effort) their objects.
 */
import { and, eq } from 'drizzle-orm'
import { has, Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { messages, type MessageRow } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, NotFoundError, ValidationError } from '@/lib/errors'
import { assertId, loadChannelAccess, publishToChannel } from '@/lib/guild-access'
import { requireUserById } from '@/lib/guilds'
import { deleteObjects } from '@/lib/storage'
import { deleteAttachmentRows, loadAttachments } from '@/lib/uploads'
import { MESSAGE_MAX_LENGTH, toMessage } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string; mid: string }>
}

const editMessageSchema = z.object({
  content: z.string().trim().max(MESSAGE_MAX_LENGTH),
})

async function loadMessage(channelId: string, mid: string): Promise<MessageRow> {
  assertId(mid, 'message')
  const [row] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.id, mid), eq(messages.channelId, channelId)))
    .limit(1)
  if (!row) throw new NotFoundError('Unknown message')
  return row
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, mid } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    const current = await loadMessage(id, mid)
    if (current.authorId !== session.user.id) {
      throw new MissingPermissionsError('Only the author can edit a message')
    }
    const { content } = await parseBody(req, editMessageSchema)
    const attachments = (await loadAttachments([mid])).get(mid) ?? []
    if (content === '' && attachments.length === 0) {
      throw new ValidationError('content is required for a message without attachments')
    }

    const [row] = await db
      .update(messages)
      .set({ content, editedAt: new Date() })
      .where(eq(messages.id, mid))
      .returning()
    const author = await requireUserById(session.user.id)
    const message = toMessage(row, author, access.channel.guildId, attachments)
    await publishToChannel(access, 'MESSAGE_UPDATE', message)
    return NextResponse.json(message)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id, mid } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    const current = await loadMessage(id, mid)
    if (current.authorId !== session.user.id && !has(access.permissions, Permissions.MANAGE_MESSAGES)) {
      throw new MissingPermissionsError()
    }
    const keys = await db.transaction(async (tx) => {
      const keys = await deleteAttachmentRows(tx, { messageId: mid })
      await tx.delete(messages).where(eq(messages.id, mid))
      return keys
    })
    await deleteObjects(keys)
    await publishToChannel(access, 'MESSAGE_DELETE', {
      id: mid,
      channelId: id,
      guildId: access.channel.guildId,
    })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
