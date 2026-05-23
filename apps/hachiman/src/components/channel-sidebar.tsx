import { Hash, Headphones, LogOut, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { VoiceControls } from '@/components/voice-controls'
import { NavUser } from '@/components/nav-user'
import { cn } from '@/lib/utils'
import type { Channel } from '@/stores/channelStore'
import { useServerStore } from '@/stores/serverStore'
import { useUserStore } from '@/stores/userStore'

interface ChannelSidebarProps {
  serverId: string | null
  channels: Channel[]
  selectedChannelId: number | null
  voiceChannelId: number | null
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onLeaveVoice: () => void
}

/**
 * Middle-left column: lists channels for the currently selected server.
 * Each channel shows a "Join Voice" button (or "Leave" if it's the user's
 * current voice channel). Clicking the row itself selects the channel for
 * viewing (text + members) WITHOUT moving the user into it.
 */
export function ChannelSidebar(props: ChannelSidebarProps): React.JSX.Element {
  const {
    serverId,
    channels,
    selectedChannelId,
    voiceChannelId,
    onSelectChannel,
    onJoinVoice,
    onLeaveVoice
  } = props

  const server = useServerStore((s) => (serverId ? s.servers.get(serverId) : undefined))
  const username = useUserStore((s) => s.username)

  if (!serverId) {
    return (
      <aside className="bg-sidebar text-sidebar-foreground flex h-screen w-60 shrink-0 flex-col border-r">
        <div className="text-muted-foreground flex flex-1 items-center justify-center px-4 text-center text-sm">
          Add a server to get started.
        </div>
      </aside>
    )
  }

  const headerLabel = server?.name?.trim() ? server.name : serverId
  const userData = {
    name: username ?? 'Guest',
    email: serverId
  }

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-screen w-60 shrink-0 flex-col border-r">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="truncate text-sm font-semibold">{headerLabel}</h2>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        <ul className="flex flex-col gap-0.5">
          {channels.map((channel) => {
            const isSelected = selectedChannelId === channel.id
            const isVoiceHere = voiceChannelId === channel.id
            return (
              <li key={channel.id}>
                <div
                  className={cn(
                    'group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm',
                    isSelected
                      ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelectChannel(channel.id)}
                    className="flex flex-1 items-center gap-2 truncate text-left"
                    aria-current={isSelected ? 'true' : undefined}
                  >
                    <Hash className="h-4 w-4 shrink-0 opacity-70" />
                    <span className="truncate">{channel.name}</span>
                    {isVoiceHere && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Headphones
                            aria-label="Voice connected"
                            className="ml-1 h-3.5 w-3.5 shrink-0 text-primary"
                          />
                        </TooltipTrigger>
                        <TooltipContent side="right">Voice connected</TooltipContent>
                      </Tooltip>
                    )}
                  </button>
                  {isVoiceHere ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Leave voice"
                          onClick={(e) => {
                            e.stopPropagation()
                            onLeaveVoice()
                          }}
                          className="h-6 w-6 text-destructive opacity-0 group-hover:opacity-100 data-[active=true]:opacity-100"
                          data-active="true"
                        >
                          <LogOut className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">Disconnect from voice</TooltipContent>
                    </Tooltip>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Join voice in ${channel.name}`}
                          onClick={(e) => {
                            e.stopPropagation()
                            onJoinVoice(channel.id)
                          }}
                          className="h-6 w-6 opacity-0 group-hover:opacity-100"
                        >
                          <Volume2 className="h-3.5 w-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="right">Join voice</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </li>
            )
          })}
          {channels.length === 0 && (
            <li className="text-muted-foreground px-2 py-4 text-xs">No channels.</li>
          )}
        </ul>
      </div>
      <Separator />
      <VoiceControls />
      <NavUser user={userData} />
    </aside>
  )
}
