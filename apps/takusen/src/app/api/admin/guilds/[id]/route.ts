/**
 * DELETE /api/admin/guilds/:id — 204. The same delete as an owner delete
 * (`deleteGuild` in lib/guilds.ts): the DS retires the groups, attachment
 * rows, GUILD_DELETE → guild, then the objects. Admin only (contract §4 Admin API).
 */
import { adminRoute, noContent } from '@/lib/api-helpers'
import { deleteGuild } from '@/lib/guilds'
import { assertId } from '@/lib/ids'

export const DELETE = adminRoute<{ id: string }>(async ({ params }) => {
  await deleteGuild(assertId(params.id, 'guild'), null)
  return noContent()
})
