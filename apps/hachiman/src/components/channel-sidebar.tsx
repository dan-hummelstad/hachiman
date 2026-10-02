import { useMemo, useState } from 'react'
import {
  ChevronDown,
  Hash,
  LogOut,
  PhoneCall,
  Plus,
  Settings,
  Trash2,
  Users,
  Volume2
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
import { Permissions, has, type Channel, type VoiceState } from '@hachiman/client'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/icon-button'
import { SelectableRow, selectableRowClass } from '@/components/ui/selectable-row'
import { TitleBar } from '@/components/ui/title-bar'
import { NavUser } from '@/components/nav-user'
import { GuildHeader } from '@/components/shell/guild-header'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { VoiceStateBadges } from '@/components/voice/voice-state-badges'
import { VoiceConnectedPanel } from '@/components/voice-connected-panel'
import { dmName, groupChannels } from '@/lib/model'
import { ROLE_INK_SCOPE } from '@/lib/role-ink'
import {
  useDmChannels,
  useGuildChannels,
  usePermissions,
  useChannelOccupants
} from '@/hooks/use-hachiman'
import { useSpeakingMember } from '@/hooks/use-member'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { voiceService } from '@/services/VoiceService'
import { openDialog } from '@/stores/dialogStore'
import { useGuildStore } from '@/stores/guildStore'
import { selectChannel, useSelectedChannelId, useSelectedGuildId } from '@/stores/navStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Channel sidebar (240px): title bar, the selected guild's channels grouped by category
 * (or the DM list), then the voice connected panel and the user panel.
 */
export function ChannelSidebar(): React.JSX.Element {
  const guildId = useSelectedGuildId()
  return (
    <aside className="bg-sidebar text-sidebar-foreground flex h-full min-h-0 w-60 shrink-0 flex-col border-x">
      {guildId ? (
        <GuildHeader guildId={guildId} />
      ) : (
        <TitleBar left={<h2 className="truncate">Direct messages</h2>} />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-3">
        {guildId ? <GuildChannels guildId={guildId} /> : <DmList />}
      </div>
      <VoiceConnectedPanel />
      <NavUser />
    </aside>
  )
}

function DmList(): React.JSX.Element {
  const dms = useDmChannels()
  const presences = useGuildStore((s) => s.presences)
  const selectedChannelId = useSelectedChannelId()
  return (
    <ul className="flex flex-col gap-px">
      <li>
        <SelectableRow
          selected={selectedChannelId === null}
          notch={false}
          onClick={() => selectChannel(null)}
          className={SIDEBAR_ROW}
        >
          <Users className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">People</span>
        </SelectableRow>
      </li>
      <li className="section-label px-2 pt-4 pb-1">Direct messages</li>
      {dms.length === 0 && (
        <li className="text-muted-foreground px-2 py-1 text-xs">No conversations yet.</li>
      )}
      {dms.map((c) => {
        const other = c.type === 'dm' ? c.recipients?.[0] : undefined
        const name = dmName(c)
        return (
          <li key={c.id}>
            <SelectableRow
              selected={selectedChannelId === c.id}
              notch={false}
              onClick={() => selectChannel(c.id)}
              className={cn(SIDEBAR_ROW, 'h-10')}
            >
              <UserAvatar
                name={name}
                avatar={other?.avatar}
                size={24}
                status={other ? (presences.get(other.id) ?? 'offline') : undefined}
                cutout={selectedChannelId === c.id ? 'bg-accent' : 'bg-sidebar'}
              />
              <span className="truncate">{name}</span>
            </SelectableRow>
          </li>
        )
      })}
    </ul>
  )
}

/** Sidebar rows use the selectable-row look without the notch, at the sidebar's spacing. */
const SIDEBAR_ROW = 'gap-2 px-2'

function GuildChannels({ guildId }: { guildId: string }): React.JSX.Element {
  const channels = useGuildChannels(guildId)
  const selectedChannelId = useSelectedChannelId()
  const canManage = has(usePermissions(guildId), Permissions.MANAGE_CHANNELS)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  // Top-level (uncategorized) channels first, then each category with its children.
  const { loose, categories, byParent } = useMemo(() => groupChannels(channels), [channels])

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const createIn = (type: 'text' | 'voice', parentId: string): void =>
    openDialog({ kind: 'createChannel', guildId, type, parentId })

  const group = (list: Channel[]): React.JSX.Element => (
    <SortableGroup
      guildId={guildId}
      list={list}
      selectedChannelId={selectedChannelId}
      canManage={canManage}
    />
  )

  return (
    <div className="flex flex-col gap-3">
      {channels.length === 0 && (
        <p className="text-muted-foreground px-2 py-1 text-xs">No channels yet.</p>
      )}
      {loose.length > 0 && group(loose)}
      {categories.map((cat) => {
        const isCollapsed = collapsed.has(cat.id)
        const children = byParent.get(cat.id) ?? []
        // Collapsed categories still show the channel being viewed.
        const visible = isCollapsed ? children.filter((c) => c.id === selectedChannelId) : children
        return (
          <section key={cat.id}>
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div className="group/section flex h-6 items-center pr-1">
                  <button
                    type="button"
                    onClick={() => toggle(cat.id)}
                    aria-expanded={!isCollapsed}
                    className="section-label hover:text-foreground flex min-w-0 flex-1 items-center gap-1 px-1 text-left"
                  >
                    <ChevronDown
                      className={cn(
                        'size-3 shrink-0 transition-transform',
                        isCollapsed && '-rotate-90'
                      )}
                    />
                    <span className="truncate">{cat.name}</span>
                  </button>
                  {canManage && (
                    <IconButton
                      size="sm"
                      label="Create channel"
                      onClick={() => createIn('text', cat.id)}
                      className="opacity-0 group-hover/section:opacity-100 focus-visible:opacity-100"
                    >
                      <Plus />
                    </IconButton>
                  )}
                </div>
              </ContextMenuTrigger>
              {canManage && (
                <ContextMenuContent>
                  <ContextMenuItem onSelect={() => createIn('text', cat.id)}>
                    <Hash /> Create text channel
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => createIn('voice', cat.id)}>
                    <Volume2 /> Create voice channel
                  </ContextMenuItem>
                  <ChannelManageItems channelId={cat.id} noun="category" />
                </ContextMenuContent>
              )}
            </ContextMenu>
            {visible.length > 0 && group(visible)}
          </section>
        )
      })}
    </div>
  )
}

/** Edit + delete items for a channel's or category's context menu. */
function ChannelManageItems({
  channelId,
  noun
}: {
  channelId: string
  noun: 'channel' | 'category'
}): React.JSX.Element {
  return (
    <>
      <ContextMenuItem onSelect={() => openDialog({ kind: 'channelSettings', channelId })}>
        <Settings /> Edit {noun}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        variant="destructive"
        onSelect={() => openDialog({ kind: 'deleteChannel', channelId })}
      >
        <Trash2 /> Delete {noun}
      </ContextMenuItem>
    </>
  )
}

interface GroupProps {
  guildId: string
  list: Channel[]
  selectedChannelId: string | null
  canManage: boolean
}

/** One sibling group; drag-reorder renumbers the whole group via PATCH /guilds/:id/channels. */
function SortableGroup({
  guildId,
  list,
  selectedChannelId,
  canManage
}: GroupProps): React.JSX.Element {
  // 4px activation distance so a click isn't swallowed as a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over || active.id === over.id) return
    const from = list.findIndex((c) => c.id === active.id)
    const to = list.findIndex((c) => c.id === over.id)
    if (from < 0 || to < 0) return
    const body = arrayMove(list, from, to).map((c, position) => ({ id: c.id, position }))
    void hachiman.rest
      .reorderChannels(guildId, body)
      .catch((e) => console.warn('[sidebar] reorder failed', e))
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={list.map((c) => c.id)} strategy={verticalListSortingStrategy}>
        <ul className="flex flex-col gap-px">
          {list.map((c) => (
            <ChannelRow
              key={c.id}
              guildId={guildId}
              channel={c}
              selected={selectedChannelId === c.id}
              canManage={canManage}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}

function ChannelRow({
  guildId,
  channel,
  selected,
  canManage
}: {
  guildId: string
  channel: Channel
  selected: boolean
  canManage: boolean
}): React.JSX.Element {
  const isVoice = channel.type === 'voice'
  const Icon = isVoice ? Volume2 : Hash
  const occupants = useChannelOccupants(guildId, channel.id)
  const isVoiceHere = useVoiceStore((s) => isVoice && s.channelId === channel.id)
  const canConnect = has(usePermissions(guildId, channel.id), Permissions.CONNECT)
  const highlighted = selected || isVoiceHere

  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: channel.id,
    disabled: !canManage
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined
  }

  const join = (): void => void voiceService.join(channel)

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li ref={setNodeRef} style={style}>
          <div
            {...attributes}
            {...listeners}
            role={undefined}
            tabIndex={-1}
            className={selectableRowClass(highlighted, 'group gap-1 pr-1 pl-0', { notch: false })}
          >
            <button
              type="button"
              onClick={() => selectChannel(channel.id)}
              onDoubleClick={isVoice ? join : undefined}
              className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left"
              aria-current={selected ? 'page' : undefined}
              aria-label={isVoice ? `${channel.name} (voice)` : undefined}
            >
              <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="truncate">{channel.name}</span>
            </button>
            {isVoiceHere ? (
              <IconButton size="sm" label="Disconnect" onClick={() => voiceService.leaveVoice()}>
                <LogOut />
              </IconButton>
            ) : (
              isVoice &&
              canConnect && (
                <IconButton
                  size="sm"
                  label="Join voice"
                  onClick={join}
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <PhoneCall />
                </IconButton>
              )
            )}
          </div>
          {occupants.length > 0 && (
            <ul className={cn('flex flex-col gap-px pt-px pb-1', ROLE_INK_SCOPE)}>
              {occupants.map((vs) => (
                <VoiceMemberRow key={vs.userId} guildId={guildId} state={vs} />
              ))}
            </ul>
          )}
        </li>
      </ContextMenuTrigger>
      {canManage && (
        <ContextMenuContent>
          <ChannelManageItems channelId={channel.id} noun="channel" />
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

function VoiceMemberRow({
  guildId,
  state
}: {
  guildId: string
  state: VoiceState
}): React.JSX.Element {
  const { member, name, ink, speaking } = useSpeakingMember(guildId, state.userId)
  return (
    <li>
      <UserProfilePopover userId={state.userId} guildId={guildId}>
        <button
          type="button"
          className={cn(
            'hover:bg-accent/60 flex h-7 w-full items-center gap-2 pr-2 pl-8 text-left text-[13px]',
            speaking ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          <UserAvatar
            name={name}
            avatar={member?.user.avatar}
            color={ink}
            size={20}
            speaking={speaking}
          />
          <span className="flex-1 truncate" style={ink ? { color: ink } : undefined}>
            {name}
          </span>
          <VoiceStateBadges state={state} />
        </button>
      </UserProfilePopover>
    </li>
  )
}
