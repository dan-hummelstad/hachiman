/**
 * POST /api/v1/channels/:id/threads { name, startMessageId? } — SEND_MESSAGES
 *      on the guild text channel :id. `startMessageId` is a message of :id.
 *      Publishes CHANNEL_CREATE (type `thread`). A thread has no MLS group of
 *      its own: it uses the group of :id (§12.6), so no DS work happens.
 * GET  /api/v1/channels/:id/threads — VIEW_CHANNEL on :id. At most 50 threads,
 *      newest activity (last message, else creation) first.
 * Rename and delete go through PATCH / DELETE /channels/:threadId (§4 Threads).
 */
import { and, desc, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels, messages } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { loadChannelAccess, publishToChannel } from '@/lib/guild-access'
import { nameSchema } from '@/lib/guild-schemas'
import { loadChannel, loadChannels } from '@/lib/guilds'
import { assertCanCreateThread, THREAD_LIST_MAX } from '@/lib/threads'

interface RouteContext {
  params: Promise<{ id: string }>
}

const createThreadSchema = z.object({
  name: nameSchema,
  startMessageId: z.string().uuid().nullable().optional(),
})

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    assertCanCreateThread(access.channel, access.permissions)
    const body = await parseBody(req, createThreadSchema)
    if (body.startMessageId) {
      const [start] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, body.startMessageId), eq(messages.channelId, id)))
        .limit(1)
      if (!start) throw new ValidationError('startMessageId must be a message of the channel')
    }
    const [row] = await db
      .insert(channels)
      .values({
        guildId: access.channel.guildId,
        type: 'thread',
        name: body.name,
        parentId: id,
        ownerId: session.user.id,
        threadStartMessageId: body.startMessageId ?? null,
      })
      .returning()
    const thread = await loadChannel(row!.id)
    await publishToChannel({ channel: row!, participantIds: [] }, 'CHANNEL_CREATE', thread)
    return NextResponse.json(thread)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadChannelAccess(id, session.user.id)
    const rows = await db
      .select({ id: channels.id })
      .from(channels)
      .where(and(eq(channels.parentId, id), eq(channels.type, 'thread')))
      .orderBy(desc(channels.lastActivityAt), desc(channels.id))
      .limit(THREAD_LIST_MAX)
    return NextResponse.json(await loadChannels(rows.map((r) => r.id)))
  } catch (err) {
    return errorResponse(err)
  }
}
