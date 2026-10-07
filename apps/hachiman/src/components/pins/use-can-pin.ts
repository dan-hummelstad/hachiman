import { Permissions, has, type Channel } from '@hachiman/client'
import { usePermissions } from '@/hooks/use-hachiman'

/** Whether I may pin and unpin in `channel`: MANAGE_MESSAGES in a guild, anyone in a DM. */
export function useCanPin(channel: Pick<Channel, 'id' | 'guildId'>): boolean {
  const perms = usePermissions(channel.guildId, channel.id)
  return channel.guildId === null || has(perms, Permissions.MANAGE_MESSAGES)
}
