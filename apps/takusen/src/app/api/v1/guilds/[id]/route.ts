/**
 * GET    /api/v1/guilds/:id — GuildFull (member).
 * PATCH  /api/v1/guilds/:id { name?, icon?, banner?, region? } — MANAGE_GUILD.
 *        icon / banner take the caller's image upload id (stored as its key).
 * DELETE /api/v1/guilds/:id — owner only. Deletes its messages' attachment
 *        rows, then (best effort) their objects.
 */
import { eq } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { guilds, type GuildRow } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { MissingPermissionsError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { assertRegion, nameSchema, regionCodeSchema } from '@/lib/guild-schemas'
import { deleteGuild, loadGuildFull } from '@/lib/guilds'
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
    const { icon, banner, ...rest } = await parseBody(req, updateGuildSchema)
    await assertRegion(rest.region)

    const row = await db.transaction(async (tx) => {
      const changes: Partial<GuildRow> = { ...rest }
      if (icon !== undefined) {
        changes.icon = icon === null ? null : await claimImage(tx, icon, session.user.id)
      }
      if (banner !== undefined) {
        changes.banner = banner === null ? null : await claimImage(tx, banner, session.user.id)
      }
      if (Object.keys(changes).length === 0) return access.guild
      const [updated] = await tx.update(guilds).set(changes).where(eq(guilds.id, id)).returning()
      return updated
    })
    const guild = toGuild(row)
    await publishToGuild(id, 'GUILD_UPDATE', guild)
    return NextResponse.json(guild)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    if (access.guild.ownerId !== session.user.id) {
      throw new MissingPermissionsError('Only the owner can delete a guild')
    }
    await deleteGuild(id)
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
