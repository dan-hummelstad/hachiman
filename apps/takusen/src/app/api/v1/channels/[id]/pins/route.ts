/**
 * GET /api/v1/channels/:id/pins — the pinned ciphertext Messages, newest pin
 *     first; VIEW_CHANNEL + READ_MESSAGE_HISTORY (§4 "Pins").
 */
import { desc, eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { channelPins, messages, users } from '@/db/schema'
import { errorResponse } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { loadChannelAccess, requirePermission } from '@/lib/guild-access'
import { userColumns } from '@/lib/guilds'
import { MAX_PINS_PER_CHANNEL } from '@/lib/pins'
import { loadAttachments } from '@/lib/uploads'
import { toMessage } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadChannelAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.READ_MESSAGE_HISTORY)
    const rows = await db
      .select({ message: messages, author: userColumns })
      .from(channelPins)
      .innerJoin(messages, eq(messages.id, channelPins.messageId))
      .innerJoin(users, eq(users.id, messages.authorId))
      .where(eq(channelPins.channelId, id))
      .orderBy(desc(channelPins.pinnedAt), desc(channelPins.messageId))
      .limit(MAX_PINS_PER_CHANNEL)
    const attachments = await loadAttachments(rows.map((r) => r.message.id))
    return NextResponse.json(
      rows.map((r) => toMessage(r.message, r.author, access.channel.guildId, attachments.get(r.message.id) ?? [])),
    )
  } catch (err) {
    return errorResponse(err)
  }
}
