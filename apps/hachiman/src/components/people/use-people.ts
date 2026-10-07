import { useMemo } from 'react'
import type { User } from '@hachiman/client'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'

/** Everyone I share a guild with, except me, by username. */
export function usePeople(): User[] {
  const members = useGuildStore((s) => s.members)
  const myId = useUserStore((s) => s.me?.id)
  return useMemo(() => {
    const byId = new Map<string, User>()
    for (const guild of members.values()) {
      for (const m of guild.values()) {
        if (m.user.id !== myId && !byId.has(m.user.id)) byId.set(m.user.id, m.user)
      }
    }
    return [...byId.values()].sort((a, b) => a.username.localeCompare(b.username))
  }, [members, myId])
}

/** The people whose username contains `query` (case-insensitive). */
export function filterPeople(people: User[], query: string): User[] {
  const q = query.trim().toLowerCase()
  return q ? people.filter((u) => u.username.toLowerCase().includes(q)) : people
}
