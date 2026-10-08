import { useMemo } from 'react'
import { ChevronUp, Plus, Star, StarOff } from 'lucide-react'
import { DndContext, closestCenter, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, rectSortingStrategy } from '@dnd-kit/sortable'
import type { Channel } from '@hachiman/client'
import { STRIP_ITEM, useIconStrip, type IconStrip } from '@/components/shell/use-icon-strip'
import { UserAvatar } from '@/components/shell/user-avatar'
import { UnreadMark } from '@/components/ui/unread-mark'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/icon-button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { favouriteMove, favouriteTiles } from '@/lib/favourite-dms'
import { dmName } from '@/lib/model'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { DM_HOME, navigate, useNavStore } from '@/stores/navStore'
import { useFavouriteDms, usePrefsStore } from '@/stores/prefsStore'
import { useChannelUnread, useDmsUnread } from '@/stores/unreadStore'
import { useDragSensors, useSortableRow } from '@/hooks/use-sortable-row'
import { openDmHome } from '@/components/sidebar/sidebar-row'

/** The open tile (E2): an opaque accent wash, so the presence cutout can match it. */
const OPEN_BG = 'bg-[color-mix(in_oklab,var(--accent-primary)_17%,var(--surface-raised))]'

/**
 * The favourite DMs at the sidebar top (N6, kit "SIDEBAR · TOP"): the "Direct messages" label
 * with "+" (the DM home, where a conversation starts), then one 46px tile per favourite with
 * presence and the mention count (N7). Drag to reorder; right click to remove. With no favourites
 * only the label shows. In the DM space the label row is left out (`label` false): the space header
 * there says "Direct messages" and has "New message".
 *
 * The tiles take one line. When they do not fit, the last place is "All favourites" (a 2x2 glyph
 * of the DMs that do not fit): it expands the line in place into a grid of every favourite. The
 * open DM always shows in the line.
 */
export function FavouriteDms({ label = true }: { label?: boolean }): React.JSX.Element | null {
  const ids = useFavouriteDms()
  const channels = useChannelStore((s) => s.channels)
  const tiles = useMemo(() => favouriteTiles(ids, channels), [ids, channels])
  const tileIds = useMemo(() => tiles.map((c) => c.id), [tiles])
  const openDm = useNavStore((s) =>
    s.guildKey === DM_HOME ? (s.channelByGuild[DM_HOME] ?? null) : null
  )
  const [attach, strip] = useIconStrip({ ids: tileIds, selected: openDm, size: 46, gap: 7 })
  // 4px activation distance so a click is not taken as a drag.
  const sensors = useDragSensors()

  const onDragEnd = ({ active, over }: DragEndEvent): void => {
    if (!over) return
    const m = favouriteMove(ids, String(active.id), String(over.id))
    if (m) usePrefsStore.getState().moveFavouriteDm(m.from, m.to)
  }

  if (!label && tiles.length === 0) return null
  return (
    <section aria-label="Favourite direct messages" className="flex flex-col gap-1.5">
      {label && (
        <div className="flex h-6 items-center pr-0.5 pl-1">
          <h2 className="section-label flex-1">Direct messages</h2>
          <IconButton
            size="sm"
            label="New message"
            onClick={openDmHome}
            className="text-text-tertiary rounded-control"
          >
            <Plus />
          </IconButton>
        </div>
      )}
      {tiles.length > 0 && (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={strip.shown} strategy={rectSortingStrategy}>
            <ul
              ref={attach}
              onKeyDown={strip.onKeyDown}
              className="border-line-hairline flex flex-wrap gap-[7px] border-b pb-2.5"
            >
              {strip.shown.map((id) => {
                const c = channels.get(id)
                return c ? <FavouriteTile key={id} channel={c} /> : null
              })}
              {strip.more && (
                <li>
                  <AllFavouritesTile strip={strip} />
                </li>
              )}
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
  const { setNodeRef, attributes, listeners, style } = useSortableRow({ id: channel.id })

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
                {...STRIP_ITEM}
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

/**
 * The last place of a full favourites line: a 2x2 glyph of the DMs that do not fit, with their
 * mention count together. Expanded, it shows a chevron and collapses the grid.
 */
function AllFavouritesTile({ strip }: { strip: IconStrip }): React.JSX.Element {
  const channels = useChannelStore((s) => s.channels)
  const badge = useDmsUnread(strip.hidden)
  const label = strip.expanded ? 'Show fewer favourites' : 'All favourites'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          {...strip.moreProps}
          className="rounded-control bg-surface-raised hover:bg-surface-hover text-text-secondary relative flex size-[46px] items-center justify-center transition-colors"
        >
          {strip.expanded ? (
            <ChevronUp className="size-4" />
          ) : (
            <span aria-hidden className="grid grid-cols-2 gap-0.5">
              {strip.hidden.slice(0, 4).map((id) => {
                const c = channels.get(id)
                const who = c?.recipients?.[0]
                return c ? (
                  <UserAvatar key={id} name={dmName(c)} avatar={who?.avatar} size={16} />
                ) : null
              })}
            </span>
          )}
          <UnreadMark badge={badge} size="corner" dot={false} className="-top-1.5 -right-1.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
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

/** "Add to favourites" or "Remove from favourites" (N6), for a DM row's or tile's menu. */
export function FavouriteDmItem({
  channelId,
  favourite
}: {
  channelId: string
  favourite: boolean
}): React.JSX.Element {
  return (
    <ContextMenuItem
      onSelect={() => usePrefsStore.getState().setFavouriteDm(channelId, !favourite)}
    >
      {favourite ? <StarOff /> : <Star />}
      {favourite ? 'Remove from favourites' : 'Add to favourites'}
    </ContextMenuItem>
  )
}
