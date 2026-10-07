/**
 * PUT    /api/v1/channels/:id/pins/:messageId — pin; MANAGE_MESSAGES (DMs: any
 *        participant). At most 50 pins per channel (400 TooManyPins). 204.
 * DELETE /api/v1/channels/:id/pins/:messageId — unpin; same rule. 204.
 * A change publishes CHANNEL_PINS_UPDATE { channelId, guildId } to the viewers
 * of the channel. A repeated PUT or DELETE changes nothing and publishes nothing.
 */
import { and, count, eq } from 'drizzle-orm'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { channelPins, channels, messages } from '@/db/schema'
import { errorResponse, noContent } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { NotFoundError } from '@/lib/errors'
import { loadChannelAccess, publishToChannel, type ChannelAccess } from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { assertCanPin, assertPinRoom } from '@/lib/pins'

interface RouteContext {
  params: Promise<{ id: string; messageId: string }>
}

async function load(ctx: RouteContext): Promise<{ access: ChannelAccess; userId: string; messageId: string }> {
  const session = await requireUser()
  const { id, messageId } = await ctx.params
  assertId(messageId, 'message')
  const access = await loadChannelAccess(id, session.user.id)
  assertCanPin(access)
  return { access, userId: session.user.id, messageId }
}

async function published(access: ChannelAccess): Promise<NextResponse> {
  await publishToChannel(access, 'CHANNEL_PINS_UPDATE', {
    channelId: access.channel.id,
    guildId: access.channel.guildId,
  })
  return noContent()
}

export async function PUT(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { access, userId, messageId } = await load(ctx)
    const channelId = access.channel.id
    const added = await db.transaction(async (tx) => {
      // Serialises the pins of one channel, so the limit holds under concurrent PUTs.
      await tx.select({ id: channels.id }).from(channels).where(eq(channels.id, channelId)).for('update')
      const [message] = await tx
        .select({ id: messages.id })
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.channelId, channelId)))
        .limit(1)
      if (!message) throw new NotFoundError('Unknown message')
      const [existing] = await tx
        .select({ messageId: channelPins.messageId })
        .from(channelPins)
        .where(and(eq(channelPins.channelId, channelId), eq(channelPins.messageId, messageId)))
        .limit(1)
      if (existing) return false
      const [{ n } = { n: 0 }] = await tx.select({ n: count() }).from(channelPins).where(eq(channelPins.channelId, channelId))
      assertPinRoom(n)
      await tx.insert(channelPins).values({ channelId, messageId, pinnedBy: userId })
      return true
    })
    return added ? await published(access) : noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { access, messageId } = await load(ctx)
    const removed = await db
      .delete(channelPins)
      .where(and(eq(channelPins.channelId, access.channel.id), eq(channelPins.messageId, messageId)))
      .returning({ messageId: channelPins.messageId })
    return removed.length > 0 ? await published(access) : noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
