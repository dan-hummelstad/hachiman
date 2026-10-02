/**
 * PATCH  /api/v1/channels/:id/messages/:mid { envelope } + X-Hachiman-Device —
 *        author only, §12.8.4 with `edit: true`. Replaces the envelope and its
 *        header columns and sets edited_at. Attachments never change.
 * DELETE /api/v1/channels/:id/messages/:mid — author or MANAGE_MESSAGES.
 *        Deletes the ciphertext and its upload rows (files and thumbnails),
 *        then (best effort) their objects.
 */
import { and, eq } from 'drizzle-orm'
import { has, Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { messages, type MessageRow } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, NotFoundError } from '@/lib/errors'
import { loadChannelAccess, publishToChannel } from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { requireUserById } from '@/lib/guilds'
import { requireDevice } from '@/lib/mls/device-auth'
import { acceptEnvelope } from '@/lib/mls/envelopes'
import { deleteObjects } from '@/lib/storage'
import { loadAttachments } from '@/lib/uploads'
import { editMessageSchema, toMessage } from '@/lib/wire'

import { drizzleMessageStore, editMessage } from '../service'

interface RouteContext {
  params: Promise<{ id: string; mid: string }>
}

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
    const userId = session.user.id
    const { id, mid } = await ctx.params
    const access = await loadChannelAccess(id, userId)
    const current = await loadMessage(id, mid)
    if (current.authorId !== userId) throw new MissingPermissionsError('Only the author can edit a message')
    const device = await requireDevice(req, userId)
    const { envelope } = await parseBody(req, editMessageSchema)

    const row = await db.transaction((tx) =>
      editMessage(drizzleMessageStore(tx), (input) => acceptEnvelope(tx, input), { row: current, userId, deviceId: device.id, envelope, now: new Date() }),
    )
    const attachments = (await loadAttachments([mid])).get(mid) ?? []
    const author = await requireUserById(userId)
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
    const keys = await db.transaction((tx) => drizzleMessageStore(tx).delete(mid))
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
