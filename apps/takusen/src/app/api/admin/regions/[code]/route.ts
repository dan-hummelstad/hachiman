/**
 * PATCH  /api/admin/regions/:code { displayName?, lat?, lon?, probeHost?, probePort? } —
 *        AdminRegion. The code cannot change.
 * DELETE /api/admin/regions/:code — 204. Guilds homed there get region null
 *        (GUILD_UPDATE → guild each). Media nodes keep their region string.
 * Admin only (contract §4 Admin API).
 */
import { eq } from 'drizzle-orm'
import { NextResponse } from 'next/server'

import { db } from '@/db/client'
import { guilds, regions } from '@/db/schema'
import { toAdminRegion } from '@/lib/admin'
import { regionGuildCount } from '@/lib/admin-stats'
import { adminRoute, noContent, parseBody } from '@/lib/api-helpers'
import { NotFoundError } from '@/lib/errors'
import { publishToGuild } from '@/lib/events'
import { publicHistoryVisibility } from '@/lib/guilds'
import { regionFieldsSchema } from '@/lib/regions'
import { toGuild } from '@/lib/wire'

const updateRegionSchema = regionFieldsSchema.partial()

export const PATCH = adminRoute<{ code: string }>(async ({ req, params: { code } }) => {
  const changes = await parseBody(req, updateRegionSchema)
  const [row] =
    Object.keys(changes).length === 0
      ? await db.select().from(regions).where(eq(regions.code, code)).limit(1)
      : await db.update(regions).set(changes).where(eq(regions.code, code)).returning()
  if (!row) throw new NotFoundError('Unknown region')
  return NextResponse.json(toAdminRegion(row, await regionGuildCount(code)))
})

export const DELETE = adminRoute<{ code: string }>(async ({ params: { code } }) => {
  const rehomed = await db.transaction(async (tx) => {
    // The FK would null these too, but silently: update them here so each
    // guild gets its GUILD_UPDATE.
    const rows = await tx.update(guilds).set({ region: null }).where(eq(guilds.region, code)).returning()
    const deleted = await tx.delete(regions).where(eq(regions.code, code)).returning({ code: regions.code })
    if (deleted.length === 0) throw new NotFoundError('Unknown region')
    return rows
  })
  await Promise.all(rehomed.map(async (g) => publishToGuild(g.id, 'GUILD_UPDATE', toGuild(g, await publicHistoryVisibility(g.id)))))
  return noContent()
})
