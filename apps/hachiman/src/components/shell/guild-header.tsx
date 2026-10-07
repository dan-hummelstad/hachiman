import { useMemo } from 'react'
import { ChevronDown, Lock } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { GuildTile } from '@/components/ui/guild-tile'
import { GuildMenuItems } from '@/components/shell/guild-menu-items'
import { useGuildStore } from '@/stores/guildStore'

/**
 * Guild header row of the sidebar (B4): crest, name and chevron; on the right the lock (every
 * guild is encrypted) and the online count. A click opens the guild menu as a popover that has
 * the width of the sidebar, under the row.
 */
export function GuildHeader({ guildId }: { guildId: string }): React.JSX.Element {
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const online = useOnlineCount(guildId)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="group/header hover:bg-surface-hover data-[state=open]:bg-surface-hover rounded-control flex h-9 w-full shrink-0 items-center gap-2 px-1.5 text-left"
        >
          {guild && (
            <GuildTile
              guild={guild}
              className="bg-surface-raised size-[22px] border-0 text-[9px]"
            />
          )}
          <span className="text-label min-w-0 truncate font-extrabold">
            {guild?.name ?? 'Loading…'}
          </span>
          <ChevronDown className="text-text-tertiary size-3.5 shrink-0 transition-transform group-data-[state=open]/header:rotate-180" />
          <span className="flex-1" />
          <Lock
            aria-label="End-to-end encrypted"
            className="text-feature-voice size-3.5 shrink-0"
          />
          <span
            className="text-text-tertiary flex shrink-0 items-center gap-1 text-xs font-semibold tabular-nums"
            aria-label={`${online} online`}
          >
            <span aria-hidden className="bg-status-online size-1.5 rounded-full" />
            {online}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="w-[var(--radix-dropdown-menu-trigger-width)] p-1.5"
      >
        <GuildMenuItems
          guildId={guildId}
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Members of the guild whose presence is not offline. */
function useOnlineCount(guildId: string): number {
  const members = useGuildStore((s) => s.members.get(guildId))
  const presences = useGuildStore((s) => s.presences)
  return useMemo(() => {
    let n = 0
    for (const id of members?.keys() ?? []) {
      const p = presences.get(id)
      if (p && p !== 'offline') n++
    }
    return n
  }, [members, presences])
}
