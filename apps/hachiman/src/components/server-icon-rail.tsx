import { MessageSquare, PlusIcon } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { GuildTile } from '@/components/ui/guild-tile'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { GuildMenuItems } from '@/components/shell/guild-menu-items'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { DM_HOME, selectGuild, useSelectedGuildId } from '@/stores/navStore'

/** Guild rail (72px): DM home, a rule, one square tile per guild, then "+" (create / join). */
export function ServerIconRail(): React.JSX.Element {
  const guilds = useGuildStore((s) => s.guilds)
  const selectedGuildId = useSelectedGuildId()

  return (
    <nav
      aria-label="Guilds"
      className="bg-rail flex h-full min-h-0 w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto py-3 [scrollbar-width:none]"
    >
      <RailTile
        label="Direct messages"
        active={selectedGuildId === null}
        onClick={() => selectGuild(DM_HOME)}
      >
        <MessageSquare className="size-5" />
      </RailTile>
      <div aria-hidden className="bg-border h-px w-8 shrink-0" />
      {[...guilds.values()].map((g) => (
        <ContextMenu key={g.id}>
          <ContextMenuTrigger asChild>
            <RailTile
              label={g.name}
              active={selectedGuildId === g.id}
              onClick={() => selectGuild(g.id)}
            >
              <GuildTile guild={g} className="size-full border-0 bg-transparent text-inherit" />
            </RailTile>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <GuildMenuItems
              guildId={g.id}
              Item={ContextMenuItem}
              Separator={ContextMenuSeparator}
            />
          </ContextMenuContent>
        </ContextMenu>
      ))}
      <RailTile
        label="Create or join a guild"
        onClick={() => openDialog({ kind: 'addGuild' })}
        className="hover:border-primary hover:text-primary border-dashed"
      >
        <PlusIcon className="size-5" />
      </RailTile>
    </nav>
  )
}

/**
 * One rail slot: the selection pill plus a 40px square button with a tooltip. Extra props
 * (e.g. from a wrapping `ContextMenuTrigger asChild`) land on the button.
 */
function RailTile({
  label,
  active = false,
  className,
  children,
  ...props
}: React.ComponentProps<'button'> & { label: string; active?: boolean }): React.JSX.Element {
  return (
    <div className="group relative flex w-full shrink-0 justify-center">
      <span
        aria-hidden
        className={cn(
          'absolute top-1/2 left-0 w-1 -translate-y-1/2 transition-all',
          active ? 'bg-primary h-8' : 'bg-muted-foreground h-0 group-hover:h-3'
        )}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex size-10 items-center justify-center overflow-hidden border transition-colors',
              active
                ? 'bg-accent text-foreground border-transparent'
                : 'bg-sidebar text-muted-foreground hover:bg-accent hover:text-foreground',
              className
            )}
            {...props}
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    </div>
  )
}
