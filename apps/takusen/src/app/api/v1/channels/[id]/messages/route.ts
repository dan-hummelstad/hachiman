/**
 * GET  /api/v1/channels/:id/messages?before=<messageId>&limit=50 — ciphertext
 *      Messages, newest first; VIEW_CHANNEL + READ_MESSAGE_HISTORY. `before`
 *      resolves server-side to its (created_at, id) so ties within a timestamp
 *      page correctly.
 * POST /api/v1/channels/:id/messages { envelope, nonce?, attachments? } +
 *      X-Hachiman-Device — SEND_MESSAGES, plus ATTACH_FILES when attachments
 *      is not empty, plus the envelope checks of §12.8.4. `attachments` lists,
 *      per pointer, the file id and then its thumbnail id (at most 20 ids).
 *      `nonce` is echoed in the response and MESSAGE_CREATE, never stored.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { messages, users } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { toAttachment } from '@/lib/files'
import { loadChannelAccess, publishToChannel, requirePermission } from '@/lib/guild-access'
import { requireUserById, userColumns } from '@/lib/guilds'
import { requireDevice } from '@/lib/mls/device-auth'
import { acceptEnvelope } from '@/lib/mls/envelopes'
import { loadAttachments } from '@/lib/uploads'
import { createMessageSchema, parseMessageQuery, toMessage } from '@/lib/wire'

import { drizzleMessageStore, sendMessage } from './service'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.READ_MESSAGE_HISTORY)
    const { before, limit } = parseMessageQuery(req.nextUrl.searchParams)

    if (before) {
      const [cursor] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, before), eq(messages.channelId, id)))
        .limit(1)
      if (!cursor) throw new ValidationError('Unknown message cursor')
    }
    // Compare in SQL so the cursor keeps Postgres' microsecond precision.
    const rows = await db
      .select({ message: messages, author: userColumns })
      .from(messages)
      .innerJoin(users, eq(users.id, messages.authorId))
      .where(
        and(
          eq(messages.channelId, id),
          before
            ? sql`(${messages.createdAt}, ${messages.id}) < (select m.created_at, m.id from ${messages} m where m.id = ${before})`
            : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(limit)
    const attachments = await loadAttachments(rows.map((r) => r.message.id))
    return NextResponse.json(
      rows.map((r) =>
        toMessage(r.message, r.author, access.channel.guildId, attachments.get(r.message.id) ?? []),
      ),
    )
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, userId)
    requirePermission(access.permissions, Permissions.SEND_MESSAGES)
    if (access.channel.type === 'voice' || access.channel.type === 'category') {
      throw new ValidationError(`Cannot send messages in a ${access.channel.type} channel`)
    }
    const device = await requireDevice(req, userId)
    const body = await parseBody(req, createMessageSchema)
    if (body.attachments.length > 0) requirePermission(access.permissions, Permissions.ATTACH_FILES)

    const { row, claimed } = await db.transaction((tx) =>
      sendMessage(drizzleMessageStore(tx), (input) => acceptEnvelope(tx, input), { channelId: id, userId, deviceId: device.id, body }),
    )
    const author = await requireUserById(userId)
    const message = toMessage(row, author, access.channel.guildId, claimed.map(toAttachment), body.nonce)
    await publishToChannel(access, 'MESSAGE_CREATE', message)
    return NextResponse.json(message)
  } catch (err) {
    return errorResponse(err)
  }
}
