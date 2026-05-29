import { PlusIcon, SettingsIcon, Trash2Icon } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NavUser } from '@/components/nav-user'
import { VoiceControls } from '@/components/voice-controls'
import { cn } from '@/lib/utils'

interface ServerIconRailProps {
  serverIds: string[]
  selectedServerId: string | null
  onSelectServer: (serverId: string) => void
  onAddServer: () => void
  onOpenServerSettings: (serverId: string) => void
  onRemoveServer: (serverId: string) => void
}

/**
 * Thin Discord-style rail on the far left. One icon per server, plus an
 * "Add Server" button. User controls (mute / deafen / account) float over
 * the bottom of the rail — the icon scroll area carries enough bottom
 * padding that the last icon can scroll into view above the overlay.
 */
export function ServerIconRail(props: ServerIconRailProps): React.JSX.Element {
  const {
    serverIds,
    selectedServerId,
    onSelectServer,
    onAddServer,
    onOpenServerSettings,
    onRemoveServer
  } = props

  return (
    <nav
      aria-label="Servers"
      className="bg-sidebar text-sidebar-foreground relative flex h-screen w-16 shrink-0 flex-col items-center gap-2 border-r py-3"
    >
      <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto pb-36">
        {serverIds.map((id) => {
          const initials = id.slice(0, 2).toUpperCase()
          const active = selectedServerId === id
          return (
            <ContextMenu key={id}>
              <Tooltip>
                {/* Both triggers compose onto the same <button> via nested
                    asChild → Slot. Wrapping Tooltip *itself* in
                    ContextMenuTrigger asChild (the previous shape) was a
                    no-op because the Tooltip Root has no DOM node for the
                    onContextMenu handler to bind to. */}
                <ContextMenuTrigger asChild>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => onSelectServer(id)}
                      aria-label={id}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'group relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all',
                        'focus-visible:ring-ring hover:rounded-xl focus:outline-none focus-visible:ring-2',
                        active && 'rounded-xl'
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'bg-primary absolute -left-3 h-6 w-1 rounded-r-full transition-all',
                          active
                            ? 'opacity-100'
                            : 'opacity-0 group-hover:h-3 group-hover:opacity-60'
                        )}
                      />
                      <Avatar className="h-10 w-10 rounded-[inherit]">
                        <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground rounded-[inherit] text-xs font-semibold">
                          {initials}
                        </AvatarFallback>
                      </Avatar>
                    </button>
                  </TooltipTrigger>
                </ContextMenuTrigger>
                <TooltipContent side="right">{id}</TooltipContent>
              </Tooltip>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => onOpenServerSettings(id)}>
                  <SettingsIcon /> Server Settings
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => onRemoveServer(id)}>
                  <Trash2Icon /> Remove server
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          )
        })}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              onClick={onAddServer}
              aria-label="Add server"
              className="h-10 w-10 rounded-2xl hover:rounded-xl"
            >
              <PlusIcon className="h-5 w-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Add Server</TooltipContent>
        </Tooltip>
      </div>
      {/* Floating user controls. Sits above the icon scroll area; the area's
          `pb-36` ensures the last icon can scroll into view above this. */}
      <div
        aria-label="User controls"
        className="bg-sidebar/85 absolute inset-x-0 bottom-0 flex flex-col items-center gap-1 border-t pb-3 pt-2 backdrop-blur"
      >
        <VoiceControls compact />
        <NavUser compact />
      </div>
    </nav>
  )
}
