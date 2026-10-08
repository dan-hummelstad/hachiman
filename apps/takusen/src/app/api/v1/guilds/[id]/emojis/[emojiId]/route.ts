/**
 * PATCH  /api/v1/guilds/:id/emojis/:emojiId { name } — MANAGE_EXPRESSIONS.
 *        Publishes GUILD_EMOJIS_UPDATE.
 * DELETE /api/v1/guilds/:id/emojis/:emojiId — MANAGE_EXPRESSIONS. Deletes the
 *        image too. Publishes GUILD_EMOJIS_UPDATE. 204.
 */
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { deleteEmoji, publishEmojis, renameEmoji, renameEmojiSchema } from '@/lib/emojis'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { deleteObjects } from '@/lib/storage'

interface RouteContext {
  params: Promise<{ id: string; emojiId: string }>
}

async function manageable(ctx: RouteContext): Promise<{ guildId: string; emojiId: string }> {
  const session = await requireUser()
  const { id, emojiId } = await ctx.params
  assertId(emojiId, 'emoji')
  const access = await loadGuildAccess(id, session.user.id)
  requirePermission(access.permissions, Permissions.MANAGE_EXPRESSIONS)
  return { guildId: id, emojiId }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { guildId, emojiId } = await manageable(ctx)
    const body = await parseBody(req, renameEmojiSchema)
    const { emoji, emojis } = await renameEmoji(guildId, emojiId, body.name)
    await publishEmojis(guildId, emojis)
    return NextResponse.json(emoji)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { guildId, emojiId } = await manageable(ctx)
    const { key, emojis } = await deleteEmoji(guildId, emojiId)
    await publishEmojis(guildId, emojis)
    if (key) await deleteObjects([key])
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
