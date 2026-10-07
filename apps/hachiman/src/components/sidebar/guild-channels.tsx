import { useMemo, useState } from 'react'
import { ChevronDown, Plus } from 'lucide-react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, arrayMove, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Permissions, has, type Channel } from '@hachiman/client'
import { EventRow } from '@/components/events/event-row'
import { GuildHeader } from '@/components/shell/guild-header'
import { ChannelManageItems, ChannelRow } from '@/components/sidebar/channel-row'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/icon-button'
import { useGuildChannels, usePermissions } from '@/hooks/use-hachiman'
import { useDragSensors } from '@/hooks/use-sortable-row'
import { ChannelIcon } from '@/lib/channel-icon'
import { CHANNEL_KINDS, CREATE_CHANNEL_TYPES, groupChannels } from '@/lib/model'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { openDialog } from '@/stores/dialogStore'
import { useSelectedChannelId } from '@/stores/navStore'

/** The middle of the sidebar in a guild: the guild header row, then the channel list. */
export function GuildChannelList({ guildId }: { guildId: string }): React.JSX.Element {
  return (
    <>
      <GuildHeader guildId={guildId} />
      <EventRow guildId={guildId} />
      {/* Full sidebar width (its padding is 10), so the unread pip sits at the window edge. */}
      <div className="-mx-2.5 mt-2 min-h-0 flex-1 overflow-y-auto px-2.5 pb-2">
        <GuildChannels guildId={guildId} />
      </div>
    </>
  )
}

function GuildChannels({ guildId }: { guildId: string }): React.JSX.Element {
  const channels = useGuildChannels(guildId)
  const selectedChannelId = useSelectedChannelId()
  const perms = usePermissions(guildId)
  const canManage = has(perms, Permissions.MANAGE_CHANNELS)
  const canInvite = has(perms, Permissions.CREATE_INSTANT_INVITE)
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
      canInvite={canInvite}
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

interface GroupProps {
  guildId: string
  list: Channel[]
  selectedChannelId: string | null
  canManage: boolean
  canInvite: boolean
}

/** One sibling group; drag-reorder renumbers the whole group via PATCH /guilds/:id/channels. */
function SortableGroup({
  guildId,
  list,
  selectedChannelId,
  canManage,
  canInvite
}: GroupProps): React.JSX.Element {
  const sensors = useDragSensors()

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
              canInvite={canInvite}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  )
}
