/**
 * POST  /api/v1/guilds/:id/channels { name, type, parentId?, topic? } — MANAGE_CHANNELS.
 * PATCH /api/v1/guilds/:id/channels [{ id, position, parentId? }] — MANAGE_CHANNELS; 204.
 */
import { eq, max } from 'drizzle-orm'
import { Permissions } from '@hachiman/client/permissions'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'

import { db } from '@/db/client'
import { channels } from '@/db/schema'
import { errorResponse, noContent, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { ValidationError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import { loadGuildAccess, requirePermission } from '@/lib/guild-access'
import { assertParent, nameSchema } from '@/lib/guild-schemas'
import { loadChannels } from '@/lib/guilds'
import { toChannel } from '@/lib/wire'

interface RouteContext {
  params: Promise<{ id: string }>
}

const createChannelSchema = z.object({
  name: nameSchema,
  type: z.enum(['text', 'voice', 'category']),
  parentId: z.string().uuid().nullable().optional(),
  topic: z.string().max(1024).nullable().optional(),
})

const reorderSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      position: z.number().int().min(0),
      parentId: z.string().uuid().nullable().optional(),
    }),
  )
  .max(500)

export async function POST(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_CHANNELS)
    const body = await parseBody(req, createChannelSchema)
    await assertParent(id, body.parentId, body.type)

    const [{ top }] = await db
      .select({ top: max(channels.position) })
      .from(channels)
      .where(eq(channels.guildId, id))
    const [row] = await db
      .insert(channels)
      .values({
        guildId: id,
        type: body.type,
        name: body.name,
        topic: body.topic ?? null,
        parentId: body.parentId ?? null,
        position: (top ?? -1) + 1,
      })
      .returning()
    const channel = toChannel(row, [])
    await publishToGuild(id, 'CHANNEL_CREATE', channel, channel.id)
    return NextResponse.json(channel)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const { id } = await ctx.params
    const access = await loadGuildAccess(id, session.user.id)
    requirePermission(access.permissions, Permissions.MANAGE_CHANNELS)
    const updates = await parseBody(req, reorderSchema)

    const existing = await db
      .select({ id: channels.id, type: channels.type, position: channels.position, parentId: channels.parentId })
      .from(channels)
      .where(eq(channels.guildId, id))
    const byId = new Map(existing.map((c) => [c.id, c]))
    const changed: string[] = []
    for (const u of updates) {
      const current = byId.get(u.id)
      if (!current) throw new ValidationError(`Unknown channel ${u.id}`)
      if (u.parentId !== undefined) await assertParent(id, u.parentId, current.type)
      if (
        u.position !== current.position ||
        (u.parentId !== undefined && u.parentId !== current.parentId)
      ) {
        changed.push(u.id)
      }
    }

    await db.transaction(async (tx) => {
      for (const u of updates) {
        if (!changed.includes(u.id)) continue
        await tx
          .update(channels)
          .set(u.parentId === undefined ? { position: u.position } : { position: u.position, parentId: u.parentId })
          .where(eq(channels.id, u.id))
      }
    })

    for (const channel of await loadChannels(changed)) {
      await publishToGuild(id, 'CHANNEL_UPDATE', channel, channel.id)
    }
    return noContent()
  } catch (err) {
    return errorResponse(err)
  }
}
