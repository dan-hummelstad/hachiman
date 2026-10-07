import { useMemo } from 'react'
import { countOnline } from '@/lib/online-count'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

/** The members of `guildId` who are online; with null, every known user but me (the DM space). */
export function useOnlineCount(guildId: string | null): number {
  const members = useGuildStore((s) => (guildId ? s.members.get(guildId) : undefined))
  const presences = useGuildStore((s) => s.presences)
  const myId = useUserStore((s) => s.me?.id)
  return useMemo(
    () =>
      guildId === null
        ? countOnline(presences.keys(), presences, myId)
        : countOnline(members?.keys() ?? [], presences),
    [guildId, members, presences, myId]
  )
}
