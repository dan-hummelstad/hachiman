/**
 * GET   /api/v1/guilds/:id/roles — Role[] by position (member).
 * POST  /api/v1/guilds/:id/roles { name, color?, permissions? } — MANAGE_ROLES.
 *       New roles go in at position 1 (just above @everyone), Discord-style,
 *       shifting the others up so the creator can still manage it.
 * PATCH /api/v1/guilds/:id/roles [{ id, position }] — MANAGE_ROLES + hierarchy.
 */
import { and, asc, eq, gte, ne, sql } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { roles } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import {
  loadGuildAccess,
  requireAbovePosition,
  requireGrantable,
  requirePermission,
} from '@/lib/guild-access'
import { colorSchema, nameSchema, permissionsSchema } from '@/lib/guild-schemas'
import { toRole } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const createRoleSchema = z.object({
  name: nameSchema,
  color: colorSchema.optional(),
  permissions: permissionsSchema.optional(),
})

const reorderSchema = z
  .array(z.object({ id: z.string().uuid(), position: z.number().int().min(1) }))
  .max(250)

async function listRoles(guildId: string) {
  return await db.select().from(roles).where(eq(roles.guildId, guildId)).orderBy(asc(roles.position))
}

export async function GET(_req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    await loadGuildAccess(id, session.user.id)
    return NextResponse.json((await listRoles(id)).map(toRole))
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_ROLES)
    const body = await parseBody(req, createRoleSchema)
    const permissions = body.permissions ?? 0
    requireGrantable(access, permissions)

    const { created, shifted } = await db.transaction(async (tx) => {
      const shifted = await tx
        .update(roles)
        .set({ position: sql`${roles.position} + 1` })
        .where(and(eq(roles.guildId, id), ne(roles.id, id), gte(roles.position, 1)))
        .returning()
      const [created] = await tx
        .insert(roles)
        .values({ guildId: id, name: body.name, color: body.color ?? 0, position: 1, permissions })
        .returning()
      return { created, shifted }
    })

    for (const r of shifted) await publishToGuild(id, 'GUILD_ROLE_UPDATE', { guildId: id, role: toRole(r) })
    const role = toRole(created)
    await publishToGuild(id, 'GUILD_ROLE_CREATE', { guildId: id, role })
    return NextResponse.json(role)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_ROLES)
    const updates = await parseBody(req, reorderSchema)

    const changed = updates.filter((u) => {
      const current = access.roles.get(u.id)
      if (!current || u.id === id) throw new ValidationError(`Unknown or immovable role ${u.id}`)
      if (current.position === u.position) return false
      requireAbovePosition(access, current.position)
      requireAbovePosition(access, u.position)
      return true
    })

    const updated = await db.transaction(async (tx) => {
      const out = []
      for (const u of changed) {
        const [row] = await tx
          .update(roles)
          .set({ position: u.position })
          .where(and(eq(roles.id, u.id), eq(roles.guildId, id)))
          .returning()
        out.push(row)
      }
      return out
    })

    for (const r of updated) await publishToGuild(id, 'GUILD_ROLE_UPDATE', { guildId: id, role: toRole(r) })
    return NextResponse.json((await listRoles(id)).map(toRole))
  } catch (err) {
    return errorResponse(err)
  }
}
