/**
 * GET    /api/admin/guilds/:id — AdminGuildDetail: the list row, plus the banner,
 *        online members, page count and the usable invites.
 * DELETE /api/admin/guilds/:id — 204. The same delete as an owner delete
 *        (`deleteGuild` in lib/guilds.ts): the DS retires the groups, attachment
 *        rows, GUILD_DELETE → guild, then the objects.
 * Admin only (contract §4 Admin API).
 */
import { NextResponse } from 'next/server'

import { getGuildDetail } from '@/lib/admin-guilds'
import { adminRoute, noContent } from '@/lib/api-helpers'
import { deleteGuild } from '@/lib/guilds'
import { assertId } from '@/lib/ids'

export const GET = adminRoute<{ id: string }>(async ({ params }) =>
  NextResponse.json(await getGuildDetail(assertId(params.id, 'guild'))),
)

export const DELETE = adminRoute<{ id: string }>(async ({ params }) => {
  await deleteGuild(assertId(params.id, 'guild'), null)
  return noContent()
})
