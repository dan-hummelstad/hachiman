import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, MessageCircle, Plus } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { GuildMenuItems } from '@/components/shell/guild-menu-items'
import { ClusterTile, Tile, TileRow } from '@/components/shell/tile-row'
import { IconButton } from '@/components/ui/icon-button'
import { UserAvatar } from '@/components/shell/user-avatar'
import { openDmHome } from '@/components/sidebar/sidebar-row'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { GuildTile } from '@/components/ui/guild-tile'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useDmChannels } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { useSortableHoldMenu } from '@/hooks/use-sortable-row'
import { dmName, guildInitials } from '@/lib/model'
import { orderedIds, recentDms, rowSlice } from '@/lib/sidebar-tiles'
import { TOUCH_HIT } from '@/lib/touch'
import { cutMask, cutStyle, tileMark, type Hole } from '@/lib/tile-cutouts'
import { cn } from '@/lib/utils'
import { openDialog, useDialogStore } from '@/stores/dialogStore'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useMessageStore } from '@/stores/messagesStore'
import { DM_HOME, navigate, selectGuild, useNavStore, useSelectedGuildId } from '@/stores/navStore'
import { moved, useGuildOrder, usePrefsStore } from '@/stores/prefsStore'
import {
  useChannelUnread,
  useGuildUnread,
  useGuildsUnread,
  useUnreadStore
} from '@/stores/unreadStore'

/**
 * The sidebar top under search: the recent direct messages as rows, then the spaces as tiles. A
 * 1px line under them sets them off from the middle of the sidebar.
 */
export function SidebarRows(): React.JSX.Element {
  return (
    <div className="border-line-hairline -mx-3 mt-1 flex flex-col gap-2 border-b pb-3">
      <DmList />
      <GuildRow />
    </div>
  )
}

/** The recent conversations the list shows before "ALL". */
const DM_ROWS = 4

/**
 * The four most recent conversations, newest first (READY `lastMessageAt`, then each new
 * message), as rows. The last row, "ALL", opens the DM home; it is selected there and while a DM
 * that has no row is open.
 */
function DmList(): React.JSX.Element {
  const dms = useDmChannels()
  const lastAt = useUnreadStore((s) => s.lastAt)
  const all = useMemo(() => recentDms(dms, lastAt), [dms, lastAt])
  const shown = all.slice(0, DM_ROWS)
  const inDms = useSelectedGuildId() === null
  const openDm = useNavStore((s) =>
    s.guildKey === DM_HOME ? (s.channelByGuild[DM_HOME] ?? null) : null
  )
  const settings = useNavStore((s) => s.settings !== null)
  const here = inDms && !settings

  return (
    <section aria-label="Direct messages" className="flex flex-col">
      <div className="flex h-[26px] items-center px-3">
        <h2 className="cap flex-1">Direct messages</h2>
        <IconButton
          size="sm"
          label="New message"
          onClick={openDmHome}
          className={cn('text-text-disabled size-5', TOUCH_HIT)}
        >
          <Plus className="size-[13px]" />
        </IconButton>
      </div>
      <ul className="flex flex-col px-2 pt-0.5">
        {shown.map((id) => (
          <DmRow key={id} channelId={id} lit={here && openDm === id} />
        ))}
        <li>
          <button
            type="button"
            onClick={openDmHome}
            aria-current={here && (openDm === null || !shown.includes(openDm)) ? 'page' : undefined}
            className={cn(
              'rounded-row mobile:h-10 mobile:rounded-option flex h-[30px] w-full items-center gap-[9px] px-2 text-left',
              here && (openDm === null || !shown.includes(openDm))
                ? 'bg-surface-selected'
                : 'hover:bg-surface-hover'
            )}
          >
            <span className="border-line-strong text-text-tertiary flex size-5 shrink-0 items-center justify-center rounded-[5px] border">
              <MessageCircle className="size-3" />
            </span>
            <span className="cap-sm">All · {all.length}</span>
          </button>
        </li>
      </ul>
    </section>
  )
}

function DmRow({ channelId, lit }: { channelId: string; lit: boolean }): React.JSX.Element | null {
  const channel = useChannelStore((s) => s.channels.get(channelId))
  const other = channel?.recipients?.[0]
  const isGroup = channel?.type === 'group_dm'
  const status = useGuildStore((s) =>
    other && !isGroup ? (s.presences.get(other.id) ?? 'offline') : undefined
  )
  const badge = useChannelUnread(channelId)
  const typing = useMessageStore((s) => (s.typing.get(channelId)?.size ?? 0) > 0)
  if (!channel) return null
  const name = dmName(channel)
  const unread = badge.unread || badge.mentions > 0
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate({ kind: 'dm', channelId })}
        aria-current={lit ? 'page' : undefined}
        className={cn(
          'rounded-row mobile:h-10 mobile:rounded-option flex h-8 w-full items-center gap-[9px] px-2 text-left',
          lit ? 'bg-surface-selected' : 'hover:bg-surface-hover'
        )}
      >
        <UserAvatar
          name={name}
          avatar={isGroup ? (channel.icon ?? other?.avatar) : other?.avatar}
          size={20}
          status={status}
          cutout="bg-surface-panel"
        />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-[13px] mobile:text-[13.5px]',
            unread || lit ? 'text-text-primary font-semibold' : 'text-text-secondary'
          )}
        >
          {name}
        </span>
        {typing ? (
          <span className="cap-sm text-live-text">typing…</span>
        ) : (
          <UnreadMark badge={badge} size="sm" />
        )}
      </button>
    </li>
  )
}

/** The ring between two faces of a group stack: a hole in the face behind. */
const FACE_RING = 2

/**
 * The faces of a group DM row by the box width: a 30 x 28 box of 18 px faces in the drawer (M8),
 * a 40 box of 24 px faces on the DM home (M56). Places by count: one centred, two corner to
 * corner, three with the last in front at the bottom.
 */
const GROUP_STACK = {
  30: {
    h: 28,
    face: 18,
    at: [
      [[6, 5]],
      [
        [0, 0],
        [12, 10]
      ],
      [
        [0, 0],
        [12, 2],
        [6, 10]
      ]
    ]
  },
  40: {
    h: 40,
    face: 24,
    at: [
      [[8, 8]],
      [
        [0, 0],
        [16, 16]
      ],
      [
        [0, 2],
        [16, 0],
        [8, 16]
      ]
    ]
  }
} as const

/**
 * A group DM's 3-face stack (M8, M56): the first three recipients, each in front of the ones
 * before it. The ring around a face is a hole in the faces behind it, so any row fill shows through.
 */
export function GroupAvatars({
  channel,
  size
}: {
  channel: Channel
  size: keyof typeof GROUP_STACK
}): React.JSX.Element {
  const { h, face, at } = GROUP_STACK[size]
  if (channel.icon) {
    return (
      <span aria-hidden className="flex shrink-0 items-center" style={{ width: size, height: h }}>
        <UserAvatar name={dmName(channel)} avatar={channel.icon} size={h} />
      </span>
    )
  }
  const people = (channel.recipients ?? []).slice(0, 3)
  const places: readonly (readonly [number, number])[] =
    people.length > 0 ? (at[people.length - 1] ?? []) : []
  const r = face / 2
  return (
    <span aria-hidden className="relative block shrink-0" style={{ width: size, height: h }}>
      {people.map((u, i) => {
        const [x, y] = places[i] ?? [0, 0]
        const holes = places
          .slice(i + 1)
          .map(([fx, fy]): Hole => [fx - x + r, fy - y + r, r + FACE_RING])
        return (
          <span
            key={u.id}
            className="absolute flex"
            style={{ left: x, top: y, maskImage: holes.length > 0 ? cutMask(holes) : undefined }}
          >
            <UserAvatar name={u.username} avatar={u.avatar} size={face} />
          </span>
        )
      })}
    </span>
  )
}

/**
 * The guilds in the user's order. Folded: the first four, then a cluster tile of the rest with
 * their badge (no cluster with five or fewer). The cluster opens a grid of every guild, five a
 * line, with a chevron in its place that folds it; Escape or a pick folds it too. Drag a tile to
 * reorder (on a phone: hold, then move; hold and lift for the guild menu).
 */
function GuildRow(): React.JSX.Element {
  const guilds = useGuildStore((s) => s.guilds)
  const order = useGuildOrder()
  const ids = useMemo(() => orderedIds([...guilds.keys()], order), [guilds, order])
  const row = useMemo(() => rowSlice(ids, false), [ids])
  const selected = useSelectedGuildId()
  const settings = useNavStore((s) => s.settings !== null)
  const current = settings ? null : selected
  const badge = useGuildsUnread(row.hidden)
  const [open, setOpen] = useState(false)
  const expanded = open && row.cluster
  const adding = useDialogStore((s) => s.dialog?.kind === 'addGuild')

  const pick = (id: string): void => {
    selectGuild(id)
    setOpen(false)
  }
  const onMove = (fromId: string, toId: string): void => {
    usePrefsStore.getState().setGuildOrder(moved(ids, ids.indexOf(fromId), ids.indexOf(toId)))
  }
  const n = row.hidden.length

  return (
    <TileRow
      label="Spaces"
      add={{ label: 'Create or join a guild', onClick: () => openDialog({ kind: 'addGuild' }) }}
      addLit={adding}
      ids={expanded ? ids : row.tiles}
      renderTile={(id) => {
        const at = ids.indexOf(id)
        return (
          <GuildRowTile
            key={id}
            guildId={id}
            lit={current === id}
            onPick={pick}
            onMoveLeft={at > 0 ? () => onMove(id, ids[at - 1]) : undefined}
            onMoveRight={at < ids.length - 1 ? () => onMove(id, ids[at + 1]) : undefined}
          />
        )
      }}
      onMove={onMove}
      onEscape={expanded ? () => setOpen(false) : undefined}
      cluster={
        row.cluster && (
          <ClusterTile
            label={expanded ? 'Show fewer guilds' : `${n} more ${n === 1 ? 'guild' : 'guilds'}`}
            lit={!expanded && current !== null && row.hidden.includes(current)}
            badge={badge}
            expanded={expanded}
            onClick={() => setOpen(!expanded)}
            count={n}
          />
        )
      }
    />
  )
}

const GUILD_ICON = 28

/**
 * A guild tile with its unread dot and mention sum (N7); right click: the guild menu. On the
 * mobile layout a hold that lifts in place opens the menu, with Move left and Move right first
 * (the button path of the drag).
 */
function GuildRowTile({
  guildId,
  lit,
  onPick,
  onMoveLeft,
  onMoveRight
}: {
  guildId: string
  lit: boolean
  onPick: (guildId: string) => void
  /** Undefined at the start (or the end) of the order. */
  onMoveLeft?: () => void
  onMoveRight?: () => void
}): React.JSX.Element | null {
  const mobile = useLayout() === 'mobile'
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const badge = useGuildUnread(guildId)
  const menu = useSortableHoldMenu(guildId)
  if (!guild) return null
  const mark = tileMark(badge, GUILD_ICON)
  return (
    <ContextMenu open={menu.open} onOpenChange={menu.onOpenChange}>
      <ContextMenuTrigger asChild longPress={menu.longPress}>
        <Tile id={guildId} label={guild.name} lit={lit} onClick={() => onPick(guildId)}>
          <span className="relative flex" style={cutStyle(mark.holes)}>
            {guild.icon ? (
              <GuildTile guild={guild} className="size-7 border-0 text-[11px]" />
            ) : (
              <span className="font-mono text-xs font-semibold tracking-[0.3px]">
                {guildInitials(guild.name)}
              </span>
            )}
            <UnreadMark badge={badge} size="corner" className={mark.className} />
          </span>
        </Tile>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={mobile ? guild.name : undefined}>
        {mobile && (
          <>
            <ContextMenuItem disabled={!onMoveLeft} onSelect={onMoveLeft}>
              <ArrowLeft /> Move left
            </ContextMenuItem>
            <ContextMenuItem disabled={!onMoveRight} onSelect={onMoveRight}>
              <ArrowRight /> Move right
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <GuildMenuItems guildId={guildId} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
