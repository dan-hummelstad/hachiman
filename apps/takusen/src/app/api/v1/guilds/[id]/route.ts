/**
 * GET    /api/v1/guilds/:id — GuildFull (member).
 * PATCH  /api/v1/guilds/:id { name?, icon?, banner?, region?, publicHistoryVisibility?, welcomeChannelId? }
 *        — MANAGE_GUILD. icon / banner take the caller's image upload id
 *        (stored as its key). `publicHistoryVisibility` sets the value that
 *        REST mirrors for the public_set group (§12.6). `welcomeChannelId` is
 *        a text channel of the guild, or null. With no other change,
 *        X-Hachiman-Signed-Action carries the genesis action (§12.16).
 * DELETE /api/v1/guilds/:id — owner only. The DS retires the guild's groups
 *        in the same transaction. Deletes its messages' attachment rows, then
 *        (best effort) their objects.
 */
import { and, eq, ne } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels, guilds, mlsGroups, type GuildRow } from '@/db/schema'
import { enforceAdminAction, SIGNED_ACTION_HEADER } from '@/lib/admin-actions'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError, ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import { actorDeviceId, loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { assertRegion, historyVisibilitySchema, nameSchema, regionCodeSchema } from '@/lib/guild-schemas'
import { deleteGuild, loadGuildFull, publicHistoryVisibility } from '@/lib/guilds'
import { claimImage } from '@/lib/uploads'
import { toGuild } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const updateGuildSchema = z.object({
  name: nameSchema.optional(),
  icon: z.string().uuid().nullable().optional(),
  banner: z.string().uuid().nullable().optional(),
  region: regionCodeSchema.nullable().optional(),
  publicHistoryVisibility: historyVisibilitySchema.optional(),
  welcomeChannelId: z.string().uuid().nullable().optional(),
})

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadGuildAccess(id, session.user.id)
    return NextResponse.json(await loadGuildFull(id, session.user.id))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_GUILD)
    const { icon, banner, publicHistoryVisibility: visibility, ...rest } = await parseBody(req, updateGuildSchema)
    await assertRegion(rest.region)
    if (rest.welcomeChannelId) await assertTextChannel(id, rest.welcomeChannelId)
    const genesisOnly =
      icon === undefined && banner === undefined && visibility === undefined && Object.keys(rest).length === 0 && req.headers.has(SIGNED_ACTION_HEADER)

    const row = await db.transaction(async (tx) => {
      if (genesisOnly) {
        await enforceAdminAction(tx, req, { guildId: id, ownerId: access.guild.ownerId, userId: session.user.id }, 'genesis')
        return access.guild
      }
      if (visibility !== undefined) {
        await tx
          .update(mlsGroups)
          .set({ historyVisibility: visibility })
          .where(and(eq(mlsGroups.guildId, id), eq(mlsGroups.kind, 'public_set'), ne(mlsGroups.status, 'retired')))
      }
      const changes: Partial<GuildRow> = { ...rest }
      if (icon !== undefined) {
        changes.icon = icon === null ? null : await claimImage(tx, icon, session.user.id)
      }
      if (banner !== undefined) {
        changes.banner = banner === null ? null : await claimImage(tx, banner, session.user.id)
      }
      if (Object.keys(changes).length === 0) return access.guild
      const [updated] = await tx.update(guilds).set(changes).where(eq(guilds.id, id)).returning()
      return updated!
    })
    const guild = toGuild(row, await publicHistoryVisibility(id))
    if (genesisOnly) return NextResponse.json(guild)
    await publishToGuild(id, 'GUILD_UPDATE', guild)
    return NextResponse.json(guild)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    if (access.guild.ownerId !== session.user.id) {
      throw new MissingPermissionsError('Only the owner can delete a guild')
    }
    await deleteGuild(id, await actorDeviceId(req, session.user.id))
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}

async function assertTextChannel(guildId: string, channelId: string): Promise<void> {
  const [c] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.id, channelId), eq(channels.guildId, guildId), eq(channels.type, 'text')))
  if (!c) throw new ValidationError('welcomeChannelId is not a text channel of this guild')
}
