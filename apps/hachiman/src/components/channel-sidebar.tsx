import { useMemo } from 'react'
import {
  Hash,
  Headphones,
  LogOut,
  Mic,
  MicOff,
  Plus,
  Settings,
  Trash2,
  Volume2,
  VolumeX
} from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
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
import { OracleSignInPrompt } from '@/components/oracle-signin-prompt'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { useServerMembers, type ServerMember } from '@/hooks/use-server-members'
import { cn } from '@/lib/utils'
import { channelsService } from '@/services/ChannelsService'
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
  /**
   * Open the create-channel dialog. `parentId` is the prospective parent's
   * channel id — undefined means the section "+" was clicked (top-level
   * under root), present means the right-click "Create Subchannel" was
   * picked on an existing channel.
   */
  onCreateChannel: (type: ChannelType, parentId?: number) => void
  /**
   * Open the manage-channel surface (currently the server-settings dialog
   * pre-targeted at the Channels tab) focused on `channelId`.
   */
  onManageChannel: (channelId: number) => void
  /**
   * Request deletion of `channelId`. The caller is expected to surface a
   * confirm dialog before actually invoking ChannelsService.deleteChannel
   * — destructive, irreversible, and (for text channels) cascades to all
   * persisted history.
   */
  onDeleteChannel: (channelId: number) => void
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
    onCreateChannel,
    onManageChannel,
    onDeleteChannel
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

  // Sort each section by (position ASC, id ASC). Position is the server-
  // authoritative sort weight (Mumble ChannelState.position); the id-tiebreak
  // gives stable ordering when several channels share a position — e.g. on a
  // fresh server where every channel was created with position 0 before any
  // drag-and-drop reorder has happened.
  const sortByPosition = (a: Channel, b: Channel): number => a.position - b.position || a.id - b.id
  const textChannels = channels.filter((c) => c.type === 'text').sort(sortByPosition)
  const voiceChannels = channels.filter((c) => c.type === 'voice').sort(sortByPosition)

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
          onManageChannel={onManageChannel}
          onDeleteChannel={onDeleteChannel}
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
          onManageChannel={onManageChannel}
          onDeleteChannel={onDeleteChannel}
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
  onCreateChannel: (type: ChannelType, parentId?: number) => void
  onManageChannel: (channelId: number) => void
  onDeleteChannel: (channelId: number) => void
}

/**
 * Compute the new `position` value for the dragged channel given the
 * sortable section's NEW order (post-drop) and the index of the dragged
 * item in that new order. Strategy:
 *
 *   - If dropped at the top: take prev-neighbor's position - 1.
 *   - If dropped at the bottom: take next-neighbor's position + 1.
 *   - Otherwise: pick the midpoint between the two neighbors.
 *
 * The midpoint approach avoids renumbering the entire list on every drag
 * (which would spam ChannelState mutations for every other channel in the
 * section) at the cost of accumulating fractional values over time. We use
 * Math.floor on the midpoint because the on-wire `position` is int32; if
 * two neighbors are integer-adjacent (e.g. 3 and 4) we just pick
 * neighbor+1 — the next drag will tie-break by id (server-side sort key
 * matches ours: position ASC, id ASC).
 */
function computeDropPosition(channelsAfter: Channel[], dropIndex: number): number {
  const prev = dropIndex > 0 ? channelsAfter[dropIndex - 1] : null
  const next = dropIndex < channelsAfter.length - 1 ? channelsAfter[dropIndex + 1] : null
  if (!prev && next) return next.position - 1
  if (prev && !next) return prev.position + 1
  if (prev && next) {
    const mid = Math.floor((prev.position + next.position) / 2)
    // If the integer gap is too small to wedge a new value between them,
    // fall back to "after prev" — the next drag will tie-break by id.
    return mid > prev.position ? mid : prev.position + 1
  }
  return 0
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
    onCreateChannel,
    onManageChannel,
    onDeleteChannel
  } = props

  // 4px activation distance: click vs drag disambiguation. Without this
  // every mousedown on a row arms a drag and the click handler never
  // fires (you can't select a channel anymore).
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  // Bucket the section's channels by parent. We also figure out which
  // channels are visible at THIS section's top level — anything whose
  // parent isn't another channel in this same section. That covers two
  // cases cleanly:
  //   (a) real top-level channels (parent === 0 = root).
  //   (b) cross-type orphans: a voice subchannel whose parent is a text
  //       channel renders at the voice section's top level rather than
  //       disappearing (the parent isn't in `channels` for this type).
  const inSection = new Set(channels.map((c) => c.id))
  const byParent = new Map<number, Channel[]>()
  for (const c of channels) {
    const list = byParent.get(c.parent)
    if (list) list.push(c)
    else byParent.set(c.parent, [c])
  }
  for (const list of byParent.values()) list.sort(sortByPositionStable)
  const topLevel = channels.filter((c) => !inSection.has(c.parent)).sort(sortByPositionStable)

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const activeCh = channels.find((c) => c.id === active.id)
    const overCh = channels.find((c) => c.id === over.id)
    if (!activeCh || !overCh) return
    // Only allow reorder within the same sibling group. Cross-parent
    // drags are a no-op for now — the natural "move into a subtree"
    // gesture is "Manage Channel → change parent" rather than a drop.
    if (activeCh.parent !== overCh.parent) return
    const siblings = (
      inSection.has(activeCh.parent) ? (byParent.get(activeCh.parent) ?? []) : topLevel
    ).slice()
    const oldIndex = siblings.findIndex((c) => c.id === active.id)
    const newIndex = siblings.findIndex((c) => c.id === over.id)
    if (oldIndex < 0 || newIndex < 0) return
    const after = arrayMove(siblings, oldIndex, newIndex)
    const moved = after[newIndex]
    const newPosition = computeDropPosition(after, newIndex)
    if (newPosition === moved.position) return
    void channelsService
      .updateChannelPosition(serverId, moved.id, newPosition)
      .catch((err) => console.warn('[sidebar] reorder failed', err))
  }

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
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <ChannelTreeLevel
            channels={topLevel}
            byParent={byParent}
            depth={0}
            serverId={serverId}
            selectedChannelId={selectedChannelId}
            voiceChannelId={voiceChannelId}
            membersByChannel={membersByChannel}
            speakingUsers={speakingUsers}
            onSelectChannel={onSelectChannel}
            onJoinVoice={onJoinVoice}
            onLeaveVoice={onLeaveVoice}
            onCreateChannel={onCreateChannel}
            onManageChannel={onManageChannel}
            onDeleteChannel={onDeleteChannel}
          />
        </DndContext>
      )}
    </div>
  )
}

// Stable sort comparator: position ASC, id ASC. Hoisted so each section
// build doesn't allocate a fresh function.
function sortByPositionStable(a: Channel, b: Channel): number {
  return a.position - b.position || a.id - b.id
}

interface ChannelTreeLevelProps {
  channels: Channel[]
  byParent: Map<number, Channel[]>
  depth: number
  serverId: string
  selectedChannelId: number | null
  voiceChannelId: number | null
  membersByChannel: Map<number, ServerMember[]>
  speakingUsers: Set<number>
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onLeaveVoice: () => void
  onCreateChannel: (type: ChannelType, parentId?: number) => void
  onManageChannel: (channelId: number) => void
  onDeleteChannel: (channelId: number) => void
}

/**
 * One level of the channel tree: a SortableContext over a sibling group
 * (top-level or one parent's children). Each child can recursively expand
 * into another tree level via ChannelRow → ChannelTreeLevel. Nested levels
 * pick up an indent + a thin left rule so the hierarchy is visually obvious
 * without needing collapse affordances yet.
 */
function ChannelTreeLevel(props: ChannelTreeLevelProps): React.JSX.Element {
  const { channels, depth } = props
  return (
    <SortableContext items={channels.map((c) => c.id)} strategy={verticalListSortingStrategy}>
      <ul
        className={cn('flex flex-col gap-0.5', depth > 0 && 'border-border/40 ml-3 border-l pl-2')}
      >
        {channels.map((channel) => (
          <ChannelRow
            key={channel.id}
            channel={channel}
            depth={depth}
            childChannels={props.byParent.get(channel.id) ?? EMPTY_CHILDREN}
            byParent={props.byParent}
            serverId={props.serverId}
            isSelected={props.selectedChannelId === channel.id}
            isVoiceHere={channel.type === 'voice' && props.voiceChannelId === channel.id}
            members={
              channel.type === 'voice'
                ? (props.membersByChannel.get(channel.id) ?? EMPTY_MEMBERS)
                : EMPTY_MEMBERS
            }
            speakingUsers={props.speakingUsers}
            selectedChannelId={props.selectedChannelId}
            voiceChannelId={props.voiceChannelId}
            membersByChannel={props.membersByChannel}
            onSelectChannel={props.onSelectChannel}
            onJoinVoice={props.onJoinVoice}
            onLeaveVoice={props.onLeaveVoice}
            onCreateChannel={props.onCreateChannel}
            onManageChannel={props.onManageChannel}
            onDeleteChannel={props.onDeleteChannel}
          />
        ))}
      </ul>
    </SortableContext>
  )
}

// Hoisted stable empty array so a row without children doesn't get a fresh
// `[]` prop every render and bust ChannelRow memoization (when we add it).
const EMPTY_CHILDREN: Channel[] = []

interface ChannelRowProps {
  channel: Channel
  depth: number
  childChannels: Channel[]
  byParent: Map<number, Channel[]>
  serverId: string
  isSelected: boolean
  isVoiceHere: boolean
  members: ServerMember[]
  speakingUsers: Set<number>
  // Forwarded for the recursive ChannelTreeLevel below — every child row
  // needs the same selectedness/voice/membership context.
  selectedChannelId: number | null
  voiceChannelId: number | null
  membersByChannel: Map<number, ServerMember[]>
  onSelectChannel: (channelId: number) => void
  onJoinVoice: (channelId: number) => void
  onLeaveVoice: () => void
  onCreateChannel: (type: ChannelType, parentId?: number) => void
  onManageChannel: (channelId: number) => void
  onDeleteChannel: (channelId: number) => void
}

function ChannelRow(props: ChannelRowProps): React.JSX.Element {
  const {
    channel,
    childChannels,
    serverId,
    isSelected,
    isVoiceHere,
    members,
    speakingUsers,
    onSelectChannel,
    onJoinVoice,
    onLeaveVoice,
    onCreateChannel,
    onManageChannel,
    onDeleteChannel
  } = props
  const Icon = channel.type === 'voice' ? Volume2 : Hash
  const isVoice = channel.type === 'voice'
  const hasChildren = childChannels.length > 0

  // useSortable spreads `attributes` + `listeners`. We put them on the
  // inner row `<div>` (NOT the `<li>`) so a nested ChannelTreeLevel
  // inside the same `<li>` doesn't compete for pointerdown events with
  // its parent — each row's drag handle is its own surface. The 4px
  // PointerSensor distance threshold (see ChannelSection) keeps a normal
  // click on the channel name from arming a drag.
  const sortable = useSortable({ id: channel.id })
  const dragStyle = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
    // Raise the dragged row above its siblings and dim it slightly so
    // the drop target underneath is visible. Applied to the `<li>` so
    // the row's full subtree (children, voice members) moves as one
    // unit — visually conveys "this whole subtree is what's moving".
    opacity: sortable.isDragging ? 0.5 : 1,
    zIndex: sortable.isDragging ? 1 : undefined
  } as React.CSSProperties

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li ref={sortable.setNodeRef} style={dragStyle}>
          <div
            {...sortable.attributes}
            {...sortable.listeners}
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
          {hasChildren && (
            <ChannelTreeLevel
              channels={childChannels}
              byParent={props.byParent}
              depth={props.depth + 1}
              serverId={serverId}
              selectedChannelId={props.selectedChannelId}
              voiceChannelId={props.voiceChannelId}
              membersByChannel={props.membersByChannel}
              speakingUsers={speakingUsers}
              onSelectChannel={onSelectChannel}
              onJoinVoice={onJoinVoice}
              onLeaveVoice={onLeaveVoice}
              onCreateChannel={onCreateChannel}
              onManageChannel={onManageChannel}
              onDeleteChannel={onDeleteChannel}
            />
          )}
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/*
          Subchannel creation is gated to the same type as the parent. A
          mismatch (e.g. voice subchannel under a text parent) would only
          ever render as a cross-type orphan at the section's top level
          (see ChannelSection's `inSection.has(c.parent)` fallback), which
          defeats the visual hierarchy the user is building.
        */}
        {channel.type === 'text' ? (
          <ContextMenuItem onSelect={() => onCreateChannel('text', channel.id)}>
            <Hash className="mr-2 h-3.5 w-3.5" />
            Create text subchannel
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => onCreateChannel('voice', channel.id)}>
            <Volume2 className="mr-2 h-3.5 w-3.5" />
            Create voice subchannel
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => onManageChannel(channel.id)}>
          <Settings className="mr-2 h-3.5 w-3.5" />
          Manage channel
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onDeleteChannel(channel.id)}>
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Delete channel
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
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
