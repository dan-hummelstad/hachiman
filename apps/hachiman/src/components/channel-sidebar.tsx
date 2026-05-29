import { useMemo } from 'react'
import { Hash, Headphones, LogOut, Mic, MicOff, Plus, Volume2, VolumeX } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { OracleSignInPrompt } from '@/components/oracle-signin-prompt'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { useServerMembers, type ServerMember } from '@/hooks/use-server-members'
import { cn } from '@/lib/utils'
import type { Channel, ChannelType } from '@/stores/channelStore'
import { useServerStore } from '@/stores/serverStore'
import { useVoiceStore } from '@/stores/voiceStore'

// Stable empty reference for the no-members case so React doesn't see a
// new array prop every render (avoids gratuitous ChannelRow reconciliation).
const EMPTY_MEMBERS: ServerMember[] = []

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
  const members = useServerMembers(serverId)
  const speakingUsers = useVoiceStore((s) => s.speakingUsers)

  // Pre-bucket members by their current voice channel id so each ChannelRow
  // gets an O(1) lookup rather than re-filtering the full member array.
  const membersByChannel = useMemo(() => {
    const map = new Map<number, ServerMember[]>()
    for (const m of members) {
      const list = map.get(m.channelId)
      if (list) list.push(m)
      else map.set(m.channelId, [m])
    }
    return map
  }, [members])

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

  const textChannels = channels.filter((c) => c.type === 'text')
  const voiceChannels = channels.filter((c) => c.type === 'voice')

  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-screen w-60 shrink-0 flex-col border-r">
      <header className="flex h-12 shrink-0 items-center border-b px-4">
        <h2 className="truncate text-sm font-semibold">{headerLabel}</h2>
      </header>
      <OracleSignInPrompt />
      <div className="flex-1 overflow-y-auto p-2">
        <ChannelSection
          title="Text Channels"
          sectionType="text"
          serverId={serverId}
          channels={textChannels}
          selectedChannelId={selectedChannelId}
          voiceChannelId={voiceChannelId}
          membersByChannel={membersByChannel}
          speakingUsers={speakingUsers}
          onSelectChannel={onSelectChannel}
          onJoinVoice={onJoinVoice}
          onLeaveVoice={onLeaveVoice}
          onCreateChannel={onCreateChannel}
        />
        <ChannelSection
          title="Voice Channels"
          sectionType="voice"
          serverId={serverId}
          channels={voiceChannels}
          selectedChannelId={selectedChannelId}
          voiceChannelId={voiceChannelId}
          membersByChannel={membersByChannel}
          speakingUsers={speakingUsers}
          onSelectChannel={onSelectChannel}
          onJoinVoice={onJoinVoice}
          onLeaveVoice={onLeaveVoice}
          onCreateChannel={onCreateChannel}
        />
      </div>
    </aside>
  )
}

interface ChannelSectionProps {
  title: string
  sectionType: ChannelType
  serverId: string
  channels: Channel[]
  selectedChannelId: number | null
  voiceChannelId: number | null
  membersByChannel: Map<number, ServerMember[]>
  speakingUsers: Set<number>
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onLeaveVoice: () => void
  onCreateChannel: (type: ChannelType) => void
}

function ChannelSection(props: ChannelSectionProps): React.JSX.Element {
  const {
    title,
    sectionType,
    serverId,
    channels,
    selectedChannelId,
    voiceChannelId,
    membersByChannel,
    speakingUsers,
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
              serverId={serverId}
              isSelected={selectedChannelId === channel.id}
              isVoiceHere={channel.type === 'voice' && voiceChannelId === channel.id}
              members={
                channel.type === 'voice'
                  ? (membersByChannel.get(channel.id) ?? EMPTY_MEMBERS)
                  : EMPTY_MEMBERS
              }
              speakingUsers={speakingUsers}
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
  serverId: string
  isSelected: boolean
  isVoiceHere: boolean
  members: ServerMember[]
  speakingUsers: Set<number>
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onLeaveVoice: () => void
}

function ChannelRow(props: ChannelRowProps): React.JSX.Element {
  const {
    channel,
    serverId,
    isSelected,
    isVoiceHere,
    members,
    speakingUsers,
    onSelectChannel,
    onJoinVoice,
    onLeaveVoice
  } = props
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
      {isVoice && members.length > 0 && (
        <ul className="ml-6 mt-0.5 flex flex-col gap-0.5">
          {members.map((member) => (
            <VoiceMemberRow
              key={member.session}
              member={member}
              serverId={serverId}
              speaking={speakingUsers.has(member.session)}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

function VoiceMemberRow({
  member,
  serverId,
  speaking
}: {
  member: ServerMember
  serverId: string
  speaking: boolean
}): React.JSX.Element {
  return (
    <li>
      <UserProfilePopover member={member} serverId={serverId}>
        <div
          className={cn(
            'flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-xs',
            speaking ? 'text-foreground' : 'text-sidebar-foreground/70'
          )}
        >
          <div className="relative">
            <Avatar className="h-5 w-5">
              <AvatarFallback className="text-[10px]">
                {member.name.slice(0, 1).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            {speaking && (
              <span
                aria-hidden
                className="bg-primary ring-sidebar absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full ring-2"
              />
            )}
          </div>
          <span className="truncate flex-1">{member.name}</span>
          <span className="text-muted-foreground flex items-center gap-0.5">
            {member.selfMute ? (
              <MicOff className="text-destructive h-3 w-3" />
            ) : (
              <Mic className="h-3 w-3 opacity-40" />
            )}
            {member.selfDeaf && <VolumeX className="text-destructive h-3 w-3" />}
          </span>
        </div>
      </UserProfilePopover>
    </li>
  )
}
