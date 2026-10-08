/**
 * GET  /api/v1/guilds/:id/sounds — the soundboard of the guild, oldest first (member).
 * POST /api/v1/guilds/:id/sounds { id, name, emoji?, uploadId, channelId, envelope } +
 *      X-Hachiman-Device — MANAGE_EXPRESSIONS. The envelope is a doc_snapshot envelope of the
 *      public_set group, sealed in `channelId` with page id = `id` (§12.21). Claims the blob
 *      (purpose 'sound'). Publishes GUILD_SOUNDS_UPDATE to the guild. 201.
 */
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'

import { db } from '@/db/client'
import { guildSounds } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { publishToGuild } from '@/lib/events'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { requireDevice } from '@/lib/mls/device-auth'
import { acceptDocEnvelope } from '@/lib/mls/envelopes'
import {
  assertNewSoundId,
  assertSoundChannel,
  assertSoundRoom,
  claimSoundUpload,
  createSoundSchema,
  listSounds,
  toGuildSound,
} from '@/lib/sounds'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadGuildAccess(id, session.user.id)
    return NextResponse.json(await listSounds(id))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const userId = session.user.id
    const { id: guildId } = await ctx.params
    const access = await loadGuildAccess(guildId, userId)
    requirePermission(access.permissions, Permissions.MANAGE_EXPRESSIONS)
    const device = await requireDevice(req, userId)
    const body = await parseBody(req, createSoundSchema)
    const sound = await db.transaction(async (tx) => {
      await assertSoundChannel(tx, guildId, body.channelId)
      await assertNewSoundId(tx, body.id)
      await assertSoundRoom(tx, guildId)
      const accepted = await acceptDocEnvelope(tx, {
        channelId: body.channelId,
        userId,
        deviceId: device.id,
        envelope: body.envelope,
        pageId: body.id,
        kind: 'doc_snapshot',
      })
      const size = await claimSoundUpload(tx, body.uploadId, userId)
      const [row] = await tx
        .insert(guildSounds)
        .values({
          id: body.id,
          guildId,
          name: body.name,
          emoji: body.emoji ?? null,
          uploadId: body.uploadId,
          channelId: body.channelId,
          groupId: accepted.groupId,
          epoch: accepted.epoch,
          senderDevice: accepted.senderDeviceId,
          envelope: body.envelope,
          createdBy: userId,
        })
        .returning()
      return toGuildSound(row!, size)
    })
    await publishToGuild(guildId, 'GUILD_SOUNDS_UPDATE', { guildId })
    return NextResponse.json(sound, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
