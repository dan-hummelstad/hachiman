import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Guild } from '@hachiman/client'
import { useGuildStore } from '@/stores/guildStore'

/**
 * The guilds that the viewer shares with `userId`, by name (the viewer has members only of its
 * own guilds). The DM profile column and the mobile DM intro show them.
 */
export function useMutualGuilds(userId: string): Guild[] {
  const { guilds, members } = useGuildStore(
    useShallow((s) => ({ guilds: s.guilds, members: s.members }))
  )
  return useMemo(
    () =>
      [...guilds.values()]
        .filter((g) => members.get(g.id)?.has(userId))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [guilds, members, userId]
  )
}
