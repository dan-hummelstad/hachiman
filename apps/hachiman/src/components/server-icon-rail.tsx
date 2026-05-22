import { PlusIcon } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface ServerIconRailProps {
  serverIds: string[]
  selectedServerId: string | null
  onSelectServer: (serverId: string) => void
  onAddServer: () => void
}

/**
 * Thin Discord-style rail on the far left. One icon per server, plus an
 * "Add Server" button at the bottom.
 */
export function ServerIconRail(props: ServerIconRailProps): React.JSX.Element {
  const { serverIds, selectedServerId, onSelectServer, onAddServer } = props

  return (
    <TooltipProvider delayDuration={150}>
      <nav
        aria-label="Servers"
        className="bg-sidebar text-sidebar-foreground flex h-screen w-16 shrink-0 flex-col items-center gap-2 border-r py-3"
      >
        <div className="flex flex-1 flex-col items-center gap-2 overflow-y-auto">
          {serverIds.map((id) => {
            const initials = id.slice(0, 2).toUpperCase()
            const active = selectedServerId === id
            return (
              <Tooltip key={id}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => onSelectServer(id)}
                    aria-label={id}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'group relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all',
                      'hover:rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active && 'rounded-xl'
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'absolute -left-3 h-6 w-1 rounded-r-full bg-primary transition-all',
                        active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60 group-hover:h-3'
                      )}
                    />
                    <Avatar className="h-10 w-10 rounded-[inherit]">
                      <AvatarFallback className="bg-sidebar-accent text-sidebar-accent-foreground rounded-[inherit] text-xs font-semibold">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{id}</TooltipContent>
              </Tooltip>
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
      </nav>
    </TooltipProvider>
  )
}
