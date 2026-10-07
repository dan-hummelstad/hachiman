import { adminActionService } from '@/services/AdminActionService'
import { hachiman } from '@/services/hachiman'

/**
 * The fixture ids are not UUIDs, so a signed admin payload (§12.16) cannot encode. Preview sends
 * the admin changes unsigned, so that roles, member roles and channel permissions can be saved.
 */
export function stubAdminActions(): void {
  const rest = hachiman.rest
  Object.assign(adminActionService, {
    createRole: (guildId, body) => rest.createRole(guildId, body),
    updateRole: (guildId, roleId, body) => rest.updateRole(guildId, roleId, body),
    deleteRole: (guildId, roleId) => rest.deleteRole(guildId, roleId),
    reorderRoles: (guildId, positions) => rest.reorderRoles(guildId, positions),
    putOverwrite: (channelId, targetId, body) => rest.putOverwrite(channelId, targetId, body),
    deleteOverwrite: (channelId, targetId) => rest.deleteOverwrite(channelId, targetId),
    updateMember: (guildId, userId, body) => rest.updateMember(guildId, userId, body),
    updateChannel: (channelId, body) => rest.updateChannel(channelId, body)
  } satisfies Partial<typeof adminActionService>)
}
