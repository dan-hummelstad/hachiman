/**
 * DELETE /api/v1/guilds/:id/sounds/:soundId — MANAGE_EXPRESSIONS. Deletes the sound and its
 * blob. Publishes GUILD_SOUNDS_UPDATE to the guild. 204.
 */
import { Permissions } from '@hachiman/client/permissions'
import { type NextRequest, type NextResponse } from 'next/server'

import { db } from '@/db/client'
import { errorResponse, noContent } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { publishToGuild } from '@/lib/events'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { assertId } from '@/lib/ids'
import { deleteSound } from '@/lib/sounds'
import { deleteObjects } from '@/lib/storage'

interface RouteContext {
  params: Promise<{ id: string; soundId: string }>
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id: guildId, soundId } = await ctx.params
    assertId(soundId, 'sound')
    const access = await loadGuildAccess(guildId, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_EXPRESSIONS)
    const key = await db.transaction((tx) => deleteSound(tx, guildId, soundId))
    if (key) await deleteObjects([key])
    await publishToGuild(guildId, 'GUILD_SOUNDS_UPDATE', { guildId })
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
