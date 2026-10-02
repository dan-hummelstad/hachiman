/**
 * POST /api/v1/guilds { name, region? } — create a guild in one transaction:
 * the guild row, its @everyone role (id = guild id), the owner's membership
 * and the default text "general" + voice "General" channels. The DS allocates
 * the public_set group in the same transaction (`guild_created`, §12.18).
 * The create assignment goes to X-Hachiman-Device when it is given.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { DEFAULT_EVERYONE } from '@hachiman/client/permissions'

import { channels, guildMembers, guilds, roles } from '@/db/schema'
import { errorResponse, parseBody } from '@/lib/api-helpers'
import { requireUser } from '@/lib/auth-helpers'
import { publishToUser } from '@/lib/events'
import { actorDeviceId } from '@/lib/guild-access'
import { assertRegion, nameSchema, regionCodeSchema } from '@/lib/guild-schemas'
import { loadGuildFull, membershipChanged, membershipTransaction, MembershipTriggers } from '@/lib/guilds'

const createGuildSchema = z.object({
  name: nameSchema,
  region: regionCodeSchema.optional(),
})

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireUser()
    const me = session.user.id
    const { name, region } = await parseBody(req, createGuildSchema)
    await assertRegion(region)
    const actor = await actorDeviceId(req, me)

    const guildId = await membershipTransaction(async (tx) => {
      const [guild] = await tx
        .insert(guilds)
        .values({ ownerId: me, name, region: region ?? null })
        .returning({ id: guilds.id })
      await tx.insert(roles).values({
        id: guild.id,
        guildId: guild.id,
        name: '@everyone',
        position: 0,
        permissions: DEFAULT_EVERYONE,
      })
      await tx.insert(guildMembers).values({ guildId: guild.id, userId: me })
      await tx.insert(channels).values([
        { guildId: guild.id, type: 'text', name: 'general', position: 0 },
        { guildId: guild.id, type: 'voice', name: 'General', position: 0 },
      ])
      await membershipChanged(tx, MembershipTriggers.guildCreated(guild.id), actor)
      return guild.id
    })

    const full = await loadGuildFull(guildId, me)
    await publishToUser(me, 'GUILD_CREATE', full)
    return NextResponse.json(full)
  } catch (err) {
    return errorResponse(err)
  }
}
