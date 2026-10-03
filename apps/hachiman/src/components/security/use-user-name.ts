import { displayName } from '@/lib/model'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'

/** The display name of any user that the cache knows: a guild member or a DM recipient. */
export function useUserName(userId: string): string {
  const fromGuild = useGuildStore((s) => {
    for (const members of s.members.values()) {
      const m = members.get(userId)
      if (m) return displayName(m)
    }
    return null
  })
  const fromDm = useChannelStore((s) => {
    for (const c of s.channels.values()) {
      const u = c.recipients?.find((r) => r.id === userId)
      if (u) return u.username
    }
    return null
  })
  return fromGuild ?? fromDm ?? 'this person'
}
