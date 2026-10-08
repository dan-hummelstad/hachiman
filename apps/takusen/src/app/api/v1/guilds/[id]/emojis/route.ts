/**
 * GET  /api/v1/guilds/:id/emojis — GuildEmoji[], oldest first (member).
 * POST /api/v1/guilds/:id/emojis { name, uploadId } — MANAGE_EXPRESSIONS.
 *      Claims the upload as an emoji image. Publishes GUILD_EMOJIS_UPDATE.
 */
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { createEmoji, createEmojiSchema, listEmojis, publishEmojis } from '@/lib/emojis'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadGuildAccess(id, session.user.id)
    return NextResponse.json(await listEmojis(id))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_EXPRESSIONS)
    const body = await parseBody(req, createEmojiSchema)
    const { emoji, emojis } = await createEmoji(id, session.user.id, body)
    await publishEmojis(id, emojis)
    return NextResponse.json(emoji, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
