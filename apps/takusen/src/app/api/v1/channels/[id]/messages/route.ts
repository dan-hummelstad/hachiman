/**
 * GET  /api/v1/channels/:id/messages?before=<messageId>&limit=50 — newest
 *      first; VIEW_CHANNEL + READ_MESSAGE_HISTORY. `before` resolves
 *      server-side to its (created_at, id) so ties within a timestamp page
 *      correctly.
 * POST /api/v1/channels/:id/messages { content, nonce?, attachments? } —
 *      SEND_MESSAGES, plus ATTACH_FILES when attachments is not empty.
 *      `content` may be '' only with attachments. `nonce` is echoed in the
 *      response and MESSAGE_CREATE, never stored.
 */
import { and, desc, eq, sql } from 'drizzle-orm'
import { DEFAULT_LIMITS } from '@hachiman/client/files'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { messages, users } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { loadChannelAccess, publishToChannel, requirePermission } from '@/lib/guild-access'
import { requireUserById, userColumns } from '@/lib/guilds'
import { toAttachment } from '@/lib/files'
import { claimForMessage, loadAttachments } from '@/lib/uploads'
import { MESSAGE_MAX_LENGTH, parseMessageQuery, toMessage } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const createMessageSchema = z
  .object({
    content: z.string().trim().max(MESSAGE_MAX_LENGTH),
    nonce: z.union([z.string().max(64), z.number().int()]).transform(String).optional(),
    attachments: z
      .array(z.string().uuid())
      .max(DEFAULT_LIMITS.maxAttachmentsPerMessage)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate upload id')
      .default([]),
  })
  .refine((b) => b.content !== '' || b.attachments.length > 0, {
    message: 'content or attachments is required',
    path: ['content'],
  })

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
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.SEND_MESSAGES)
    if (access.channel.type === 'voice' || access.channel.type === 'category') {
      throw new ValidationError(`Cannot send messages in a ${access.channel.type} channel`)
    }
    const { content, nonce, attachments } = await parseBody(req, createMessageSchema)
    if (attachments.length > 0) requirePermission(access.permissions, Permissions.ATTACH_FILES)

    const { row, claimed } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(messages)
        .values({ channelId: id, authorId: session.user.id, content })
        .returning()
      const claimed = await claimForMessage(tx, row.id, attachments, session.user.id)
      return { row, claimed }
    })
    const author = await requireUserById(session.user.id)
    const message = toMessage(row, author, access.channel.guildId, claimed.map(toAttachment), nonce)
    await publishToChannel(access, 'MESSAGE_CREATE', message)
    return NextResponse.json(message)
  } catch (err) {
    return errorResponse(err)
  }
}
