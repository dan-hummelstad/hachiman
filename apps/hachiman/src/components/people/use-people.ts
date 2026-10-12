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

/** Everyone I share a guild with, except me and the people I blocked. */
export function useVisiblePeople(): User[] {
  const people = usePeople()
  const blocks = useUserStore((s) => s.blocks)
  return useMemo(() => people.filter((u) => !blocks.has(u.id)), [people, blocks])
}

/**
 * The visible people (`useVisiblePeople`) who are online: the one online count of the DM home,
 * its People row and the People list.
 */
export function useOnlinePeople(): User[] {
  const visible = useVisiblePeople()
  const presences = useGuildStore((s) => s.presences)
  return useMemo(
    () => visible.filter((u) => (presences.get(u.id) ?? 'offline') !== 'offline'),
    [visible, presences]
  )
}

/** The people whose username contains `query` (case-insensitive). */
export function filterPeople(people: User[], query: string): User[] {
  const q = query.trim().toLowerCase()
  return q ? people.filter((u) => u.username.toLowerCase().includes(q)) : people
}
