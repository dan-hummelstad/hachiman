import { useMemo } from 'react'
import { Plus } from 'lucide-react'
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Channel } from '@hachiman/client'
import { FavouriteDmItem } from '@/components/channel-sidebar'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UnreadMark } from '@/components/ui/unread-mark'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { favouriteMove, favouriteTiles } from '@/lib/favourite-dms'
import { dmName } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { DM_HOME, navigate, useNavStore } from '@/stores/navStore'
import { useFavouriteDms, usePrefsStore } from '@/stores/prefsStore'
import { useChannelUnread } from '@/stores/unreadStore'

/** The open tile (E2): an opaque accent wash, so the presence cutout can match it. */
const OPEN_BG = 'bg-[color-mix(in_oklab,var(--accent-primary)_17%,var(--surface-raised))]'

/**
 * The favourite DMs at the sidebar top (N6, kit "SIDEBAR · TOP"): the "Direct messages" label
 * with "+" (the DM home, where a conversation starts), then one 46px tile per favourite with
 * presence and the mention count (N7). Drag to reorder; right click to remove. With no favourites
 * only the label shows.
 */
export function FavouriteDms(): React.JSX.Element {
  const ids = useFavouriteDms()
  const channels = useChannelStore((s) => s.channels)
  const tiles = useMemo(() => favouriteTiles(ids, channels), [ids, channels])
  // 4px activation distance so a click is not taken as a drag.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over) return
    const m = favouriteMove(ids, String(active.id), String(over.id))
    if (m) usePrefsStore.getState().moveFavouriteDm(m.from, m.to)
  }

  return (
    <section aria-label="Favourite direct messages" className="flex flex-col gap-1.5">
      <div className="flex h-6 items-center pr-0.5 pl-1">
        <h2 className="section-label flex-1">Direct messages</h2>
        <IconButton
          size="sm"
          label="New message"
          onClick={() => navigate({ kind: 'dmHome' })}
          className="text-text-tertiary rounded-control"
        >
          <Plus />
        </IconButton>
      </div>
      {tiles.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={tiles.map((c) => c.id)} strategy={rectSortingStrategy}>
            <ul className="border-line-hairline flex flex-wrap gap-[7px] border-b pb-2.5">
              {tiles.map((c) => (
                <FavouriteTile key={c.id} channel={c} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </section>
  )
}

function FavouriteTile({ channel }: { channel: Channel }): React.JSX.Element {
  const name = dmName(channel)
  const isGroup = channel.type === 'group_dm'
  const other = channel.recipients?.[0]
  const status = useGuildStore((s) =>
    other && !isGroup ? (s.presences.get(other.id) ?? 'offline') : undefined
  )
  const badge = useChannelUnread(channel.id)
  const open = useNavStore(
    (s) => s.guildKey === DM_HOME && s.channelByGuild[DM_HOME] === channel.id
  )
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: channel.id
  })
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li ref={setNodeRef} style={style}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                {...attributes}
                {...listeners}
                aria-label={name}
                aria-current={open ? 'page' : undefined}
                onClick={() => navigate({ kind: 'dm', channelId: channel.id })}
                className={cn(
                  'rounded-control relative flex size-[46px] items-center justify-center border transition-colors',
                  open
                    ? cn(OPEN_BG, 'border-accent-primary/40')
                    : 'bg-surface-raised hover:bg-surface-hover border-transparent'
                )}
              >
                <span className="relative flex">
                  {isGroup ? (
                    <GroupAvatars channel={channel} />
                  ) : (
                    <UserAvatar
                      name={name}
                      avatar={other?.avatar}
                      size={28}
                      status={status}
                      cutout={open ? OPEN_BG : 'bg-surface-raised'}
                    />
                  )}
                  <UnreadMark
                    badge={badge}
                    size="corner"
                    dot={false}
                    className="-top-1.5 -right-2"
                  />
                </span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{name}</TooltipContent>
          </Tooltip>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <FavouriteDmItem channelId={channel.id} favourite />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** Two stacked avatars for a group DM: the first two recipients, offset diagonally. */
function GroupAvatars({ channel }: { channel: Channel }): React.JSX.Element {
  const [a, b] = channel.recipients ?? []
  return (
    <span className="relative block size-[32px]">
      <UserAvatar
        name={a?.username ?? '?'}
        avatar={a?.avatar}
        size={22}
        className="absolute top-0 left-0"
      />
      {b && (
        <UserAvatar
          name={b.username}
          avatar={b.avatar}
          size={22}
          className="ring-surface-raised absolute right-0 bottom-0 rounded-full ring-2"
        />
      )}
    </span>
  )
}
