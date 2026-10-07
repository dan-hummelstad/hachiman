import type { Channel } from '@hachiman/client'
import { canPinIn } from '@/components/chat/row-policy'
import { usePermissions } from '@/hooks/use-hachiman'

/** Whether I may pin and unpin in `channel`: MANAGE_MESSAGES in a guild, anyone in a DM. */
export function useCanPin(channel: Pick<Channel, 'id' | 'guildId'>): boolean {
  return canPinIn(channel, usePermissions(channel.guildId, channel.id))
}
