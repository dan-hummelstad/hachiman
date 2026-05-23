import { Hash, Headphones, LogOut, Plus, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Separator } from '@/components/ui/separator'
import { VoiceControls } from '@/components/voice-controls'
import { NavUser } from '@/components/nav-user'
import { cn } from '@/lib/utils'
import type { Channel, ChannelType } from '@/stores/channelStore'
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
  onCreateChannel: (type: ChannelType) => void
}

/**
 * Middle-left column: lists channels for the currently selected server,
 * grouped Discord-style into Text and Voice sections. Text channels render
 * as chat-only entries (no Join Voice affordance); voice channels keep both
 * the click-to-view selector and the Join/Leave button.
 */
export function ChannelSidebar(props: ChannelSidebarProps): React.JSX.Element {
  const {
    serverId,
    channels,
    selectedChannelId,
    voiceChannelId,
    onSelectChannel,
    onJoinVoice,
    onLeaveVoice,
    onCreateChannel
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

  const textChannels = channels.filter((c) => c.type === 'text')
  const voiceChannels = channels.filter((c) => c.type === 'voice')

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-screen w-60 shrink-0 flex-col border-r">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="truncate text-sm font-semibold">{headerLabel}</h2>
      </header>
      <div className="flex-1 overflow-y-auto p-2">
        <ChannelSection
          title="Text Channels"
          sectionType="text"
          channels={textChannels}
          selectedChannelId={selectedChannelId}
          voiceChannelId={voiceChannelId}
          onSelectChannel={onSelectChannel}
          onJoinVoice={onJoinVoice}
          onLeaveVoice={onLeaveVoice}
          onCreateChannel={onCreateChannel}
        />
        <ChannelSection
          title="Voice Channels"
          sectionType="voice"
          channels={voiceChannels}
          selectedChannelId={selectedChannelId}
          voiceChannelId={voiceChannelId}
          onSelectChannel={onSelectChannel}
          onJoinVoice={onJoinVoice}
          onLeaveVoice={onLeaveVoice}
          onCreateChannel={onCreateChannel}
        />
      </div>
      <Separator />
      <VoiceControls />
      <NavUser user={userData} />
    </aside>
  )
}

interface ChannelSectionProps {
  title: string
  sectionType: ChannelType
  channels: Channel[]
  selectedChannelId: number | null
  voiceChannelId: number | null
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onLeaveVoice: () => void
  onCreateChannel: (type: ChannelType) => void
}

function ChannelSection(props: ChannelSectionProps): React.JSX.Element {
  const {
    title,
    sectionType,
    channels,
    selectedChannelId,
    voiceChannelId,
    onSelectChannel,
    onJoinVoice,
    onLeaveVoice,
    onCreateChannel
  } = props

  return (
    <div className="mb-3">
      <div className="group/section flex items-center justify-between px-2 pb-1 pt-2">
        <span className="text-muted-foreground/80 text-[11px] font-semibold uppercase tracking-wider">
          {title}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Create ${sectionType} channel`}
              onClick={() => onCreateChannel(sectionType)}
              className="h-5 w-5 opacity-0 group-hover/section:opacity-100"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">Create channel</TooltipContent>
        </Tooltip>
      </div>
      {channels.length === 0 ? (
        <p className="text-muted-foreground px-2 py-1 text-[11px] italic">No channels yet.</p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {channels.map((channel) => (
            <ChannelRow
              key={channel.id}
              channel={channel}
              isSelected={selectedChannelId === channel.id}
              isVoiceHere={channel.type === 'voice' && voiceChannelId === channel.id}
              onSelectChannel={onSelectChannel}
              onJoinVoice={onJoinVoice}
              onLeaveVoice={onLeaveVoice}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

interface ChannelRowProps {
  channel: Channel
  isSelected: boolean
  isVoiceHere: boolean
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onLeaveVoice: () => void
}

function ChannelRow(props: ChannelRowProps): React.JSX.Element {
  const { channel, isSelected, isVoiceHere, onSelectChannel, onJoinVoice, onLeaveVoice } = props
  const Icon = channel.type === 'voice' ? Volume2 : Hash
  const isVoice = channel.type === 'voice'

  return (
    <li>
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
          <Icon className="h-4 w-4 shrink-0 opacity-70" />
          <span className="truncate">{channel.name}</span>
          {isVoiceHere && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Headphones
                  aria-label="Voice connected"
                  className="text-primary ml-1 h-3.5 w-3.5 shrink-0"
                />
              </TooltipTrigger>
              <TooltipContent side="right">Voice connected</TooltipContent>
            </Tooltip>
          )}
        </button>
        {isVoice && isVoiceHere && (
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
                className="text-destructive h-6 w-6 opacity-0 group-hover:opacity-100 data-[active=true]:opacity-100"
                data-active="true"
              >
                <LogOut className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">Disconnect from voice</TooltipContent>
          </Tooltip>
        )}
        {isVoice && !isVoiceHere && (
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
}
