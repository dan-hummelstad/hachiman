import { useMemo } from 'react'
import { Permissions, has, highestRolePosition } from '@hachiman/client'
import { usePermissions, useRoleCeiling } from '@/hooks/use-hachiman'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

/** What the current user may do to a member (contract §4 Bans: the moderation rule). */
export interface ModerationRights {
  kick: boolean
  ban: boolean
  mute: boolean
  deafen: boolean
  move: boolean
}

const NONE: ModerationRights = { kick: false, ban: false, mute: false, deafen: false, move: false }

/**
 * The server rule on the client: never yourself or the owner, and the top role of the member must
 * be below mine (owner and ADMINISTRATOR exempt), then one permission per action.
 */
export function useModerationRights(guildId: string | null, userId: string): ModerationRights {
  const perms = usePermissions(guildId)
  const ceiling = useRoleCeiling(guildId)
  const myId = useUserStore((s) => s.me?.id)
  const ownerId = useGuildStore((s) => (guildId ? s.guilds.get(guildId)?.ownerId : undefined))
  const member = useGuildStore((s) => (guildId ? s.members.get(guildId)?.get(userId) : undefined))
  const roles = useGuildStore((s) => (guildId ? s.roles.get(guildId) : undefined))
  return useMemo(() => {
    if (!guildId || !member || !roles || userId === myId || userId === ownerId) return NONE
    if (highestRolePosition(member, roles) >= ceiling) return NONE
    return {
      kick: has(perms, Permissions.KICK_MEMBERS),
      ban: has(perms, Permissions.BAN_MEMBERS),
      mute: has(perms, Permissions.MUTE_MEMBERS),
      deafen: has(perms, Permissions.DEAFEN_MEMBERS),
      move: has(perms, Permissions.MOVE_MEMBERS)
    }
  }, [guildId, member, roles, userId, myId, ownerId, perms, ceiling])
}
