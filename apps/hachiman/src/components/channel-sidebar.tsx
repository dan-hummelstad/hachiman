import { useMemo, useState } from 'react'
import {
  ChevronDown,
  HeadphoneOff,
  Lock,
  Megaphone,
  MessageCircle,
  MicOff,
  PhoneCall,
  Plus,
  Settings,
  SquarePen,
  Trash2,
  UserPlus,
  Users
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
import { SystemTag } from '@/components/ui/system-tag'
import { useChannelAccess } from '@/lib/channel-access'
import { GuildHeader } from '@/components/shell/guild-header'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UserProfilePopover } from '@/components/user-profile-popover'
import { ChannelIcon } from '@/lib/channel-icon'
import { CHANNEL_KINDS, CREATE_CHANNEL_TYPES, dmName, groupChannels } from '@/lib/model'
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
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { selectChannel, useSelectedChannelId } from '@/stores/navStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'

/** A 30px sidebar row (padding 0/8/0/10): hover fill, and the selected fill with radius 8. */
function rowClass(selected: boolean, className?: string): string {
  return cn(
    'rounded-control flex h-[30px] w-full items-center gap-2 pr-2 pl-2.5 text-left text-label',
    selected
      ? 'bg-surface-selected text-text-primary font-bold'
      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
    className
  )
}

// MARK: - Guild space

/** The middle of the sidebar in a guild: the guild header row, then the channel list. */
export function GuildChannelList({ guildId }: { guildId: string }): React.JSX.Element {
  return (
    <>
      <GuildHeader guildId={guildId} />
      <div className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <GuildChannels guildId={guildId} />
      </div>
    </>
  )
}

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

  const createIn = (type: (typeof CREATE_CHANNEL_TYPES)[number], parentId: string): void =>
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
        <p className="text-text-tertiary px-2.5 py-1 text-xs">No channels yet.</p>
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
                <div className="flex h-[30px] items-center pr-1">
                  <button
                    type="button"
                    onClick={() => toggle(cat.id)}
                    aria-expanded={!isCollapsed}
                    className="section-label hover:text-text-secondary flex h-full min-w-0 flex-1 items-center gap-1.5 pl-1 text-left"
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
                      className="text-text-tertiary rounded-control"
                    >
                      <Plus />
                    </IconButton>
                  )}
                </div>
              </ContextMenuTrigger>
              {canManage && (
                <ContextMenuContent>
                  {CREATE_CHANNEL_TYPES.map((t) => (
                    <ContextMenuItem key={t} onSelect={() => createIn(t, cat.id)}>
                      <ChannelIcon type={t} /> Create {CHANNEL_KINDS[t].label.toLowerCase()} channel
                    </ContextMenuItem>
                  ))}
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
        <ul className="flex flex-col gap-0.5">
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
  const occupants = useChannelOccupants(guildId, channel.id)
  const isVoiceHere = useVoiceStore((s) => isVoice && s.channelId === channel.id)
  const canConnect = has(usePermissions(guildId, channel.id), Permissions.CONNECT)
  const canInvite = has(usePermissions(guildId), Permissions.CREATE_INSTANT_INVITE)
  const { readOnly, restricted } = useChannelAccess(channel)

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
  const lockLabel = restricted ? 'Restricted channel' : 'Read only'
  const showActions = selected ? 'flex' : 'hidden group-hover/row:flex group-focus-within/row:flex'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li ref={setNodeRef} style={style}>
          <div
            {...attributes}
            {...listeners}
            role={undefined}
            tabIndex={-1}
            className={rowClass(selected, 'group/row gap-1 pr-1 pl-0')}
          >
            <button
              type="button"
              onClick={() => selectChannel(channel.id)}
              onDoubleClick={isVoice ? join : undefined}
              className={cn(
                'flex h-full min-w-0 flex-1 items-center gap-2 pl-2.5 text-left',
                isVoiceHere && !selected && 'text-feature-voice-text'
              )}
              aria-current={selected ? 'page' : undefined}
              aria-label={
                readOnly
                  ? `${channel.name} (read only)`
                  : channel.type === 'text'
                    ? undefined
                    : `${channel.name} (${channel.type})`
              }
            >
              {readOnly ? (
                <Megaphone className="text-feature-event size-4 shrink-0" aria-hidden />
              ) : (
                <ChannelIcon
                  type={channel.type}
                  className={cn(
                    'size-4 shrink-0',
                    isVoice ? 'text-feature-voice' : 'text-text-tertiary'
                  )}
                  aria-hidden
                />
              )}
              <span className="truncate">{channel.name}</span>
            </button>
            <span
              className={cn(
                'items-center gap-1 pr-1',
                selected ? 'hidden' : 'flex group-hover/row:hidden group-focus-within/row:hidden'
              )}
            >
              {channel.type === 'pages' && <SystemTag kind="page" />}
              {(readOnly || restricted) && (
                <Lock aria-label={lockLabel} className="text-text-tertiary size-3.5" />
              )}
            </span>
            <span className={cn('items-center', showActions)}>
              {isVoice && canConnect && !isVoiceHere && (
                <IconButton size="sm" label="Join voice" onClick={join} className="rounded-control">
                  <PhoneCall />
                </IconButton>
              )}
              {canInvite && (
                <IconButton
                  size="sm"
                  label="Invite people"
                  onClick={() => openDialog({ kind: 'invite', guildId })}
                  className="rounded-control"
                >
                  <UserPlus />
                </IconButton>
              )}
              {canManage && (
                <IconButton
                  size="sm"
                  label="Channel settings"
                  onClick={() => openDialog({ kind: 'channelSettings', channelId: channel.id })}
                  className="rounded-control"
                >
                  <Settings />
                </IconButton>
              )}
            </span>
          </div>
          {occupants.length > 0 && (
            <ul className={cn('flex flex-col pt-0.5 pb-1', ROLE_INK_SCOPE)}>
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

/** A voice participant: 26 high, indent 34, with the LIVE tag and the mute and deafen marks. */
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
            'hover:bg-surface-hover rounded-control flex h-[26px] w-full items-center gap-2 pr-2 pl-[34px] text-left text-[14px]',
            speaking ? 'text-text-primary font-semibold' : 'text-text-secondary'
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
          {state.selfStream && <SystemTag kind="live" />}
          {state.selfMute && (
            <MicOff aria-label="Muted" className="text-feature-danger size-3.5 shrink-0" />
          )}
          {state.selfDeaf && (
            <HeadphoneOff aria-label="Deafened" className="text-feature-danger size-3.5 shrink-0" />
          )}
        </button>
      </UserProfilePopover>
    </li>
  )
}

// MARK: - DM space

/**
 * The middle of the sidebar in the DM space (E1–E3): the "Direct messages" header with "New
 * message", the People row with the online count, and the conversations.
 */
export function DmSpace(): React.JSX.Element {
  const selectedChannelId = useSelectedChannelId()
  const online = useOnlineFriends()
  const openPeople = (): void => selectChannel(null)

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 px-1.5">
        <span className="bg-accent-primary text-text-on-accent flex size-[22px] shrink-0 items-center justify-center rounded-full">
          <MessageCircle className="size-3" />
        </span>
        <h2 className="text-label min-w-0 flex-1 truncate font-extrabold">Direct messages</h2>
        <IconButton label="New message" onClick={openPeople} className="rounded-control">
          <SquarePen />
        </IconButton>
      </div>
      <div className="-mx-1 mt-2 min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        <button
          type="button"
          onClick={openPeople}
          aria-current={selectedChannelId === null ? 'page' : undefined}
          className={rowClass(selectedChannelId === null)}
        >
          <Users className="text-text-tertiary size-4 shrink-0" />
          <span className="flex-1 truncate">People</span>
          <span className="text-text-tertiary text-xs font-semibold">{online} online</span>
        </button>
        <h3 className="section-label flex h-[30px] items-center px-1 pt-3">Conversations</h3>
        <DmList />
      </div>
    </>
  )
}

/** Users other than me whose presence is not offline. */
function useOnlineFriends(): number {
  const presences = useGuildStore((s) => s.presences)
  const myId = useUserStore((s) => s.me?.id)
  return useMemo(() => {
    let n = 0
    for (const [id, p] of presences) if (id !== myId && p !== 'offline') n++
    return n
  }, [presences, myId])
}

/** The DM and group DM rows: avatar, name, the last decrypted message and LIVE. */
export function DmList(): React.JSX.Element {
  const dms = useDmChannels()
  const selectedChannelId = useSelectedChannelId()
  if (dms.length === 0)
    return <p className="text-text-tertiary px-2.5 py-1 text-xs">No conversations yet.</p>
  return (
    <ul className="flex flex-col gap-0.5">
      {dms.map((c) => (
        <DmRow key={c.id} channel={c} selected={selectedChannelId === c.id} />
      ))}
    </ul>
  )
}

function DmRow({ channel, selected }: { channel: Channel; selected: boolean }): React.JSX.Element {
  const isGroup = channel.type === 'group_dm'
  const other = channel.recipients?.[0]
  const name = dmName(channel)
  const status = useGuildStore((s) =>
    other ? (s.presences.get(other.id) ?? 'offline') : undefined
  )
  const preview = useMessageStore((s) => previewOf(s.byChannel.get(channel.id), isGroup))
  const live = useVoiceStore((s) =>
    other && !isGroup ? isStreaming(s.voiceStates, other.id) : false
  )

  return (
    <li>
      <button
        type="button"
        onClick={() => selectChannel(channel.id)}
        aria-current={selected ? 'page' : undefined}
        className={rowClass(selected, 'h-[46px] gap-2.5 pl-1.5 font-normal')}
      >
        <UserAvatar
          name={name}
          avatar={other?.avatar}
          size={32}
          status={isGroup ? undefined : status}
          cutout="bg-surface-window"
        />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="text-text-primary truncate text-[14px] font-bold">{name}</span>
          {preview && <span className="text-text-tertiary truncate text-xs">{preview}</span>}
        </span>
        {live && <SystemTag kind="live" />}
      </button>
    </li>
  )
}

/** The text of the last decrypted message, with its author in a group. */
function previewOf(messages: ChatMessage[] | undefined, withAuthor: boolean): string | null {
  if (!messages) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.decrypt.status !== 'ok') continue
    const text = m.content.trim() || (m.attachments.length > 0 ? 'Sent an attachment' : '')
    if (!text) continue
    return withAuthor ? `${m.author.username}: ${text}` : text
  }
  return null
}

function isStreaming(
  voiceStates: ReadonlyMap<string, ReadonlyMap<string, VoiceState>>,
  userId: string
): boolean {
  for (const states of voiceStates.values()) if (states.get(userId)?.selfStream) return true
  return false
}
