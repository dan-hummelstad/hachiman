/**
 * DELETE /api/admin/guilds/:id/invites/:code — 204. Revokes the invite as
 * `DELETE /api/v1/invites/:code` does (bundles deleted, INVITE_DELETE → guild),
 * without the MANAGE_GUILD check. Admin only (contract §4 Admin API).
 */
import { revokeGuildInvite } from '@/lib/admin-guilds'
import { adminRoute, noContent } from '@/lib/api-helpers'
import { assertId } from '@/lib/ids'

export const DELETE = adminRoute<{ id: string; code: string }>(async ({ params }) => {
  await revokeGuildInvite(assertId(params.id, 'guild'), params.code)
  return noContent()
})
