import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, MessageCircle } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { GuildMenuItems } from '@/components/shell/guild-menu-items'
import { ClusterTile, Tile, TileRow } from '@/components/shell/tile-row'
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
import { presenceHole } from '@/components/ui/presence'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useDmChannels } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { useSortableHoldMenu } from '@/hooks/use-sortable-row'
import { dmName } from '@/lib/model'
import { orderedIds, recentDms, rowSlice, tileSurface } from '@/lib/sidebar-tiles'
import { cutMask, cutStyle, shiftHoles, tileMark, type Hole } from '@/lib/tile-cutouts'
import { cn } from '@/lib/utils'
import { openDialog, useDialogStore } from '@/stores/dialogStore'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { DM_HOME, navigate, selectGuild, useNavStore, useSelectedGuildId } from '@/stores/navStore'
import { moved, useGuildOrder, usePrefsStore } from '@/stores/prefsStore'
import {
  useChannelUnread,
  useDmsUnread,
  useGuildUnread,
  useGuildsUnread,
  useUnreadStore
} from '@/stores/unreadStore'

/**
 * The two tile rows of the sidebar top, under search (docs/ui-redesign.md §7): recent DMs, then
 * guilds. A 1px line under them sets them off from the middle of the sidebar.
 */
export function SidebarRows(): React.JSX.Element {
  return (
    <div className="border-line-hairline mt-1 flex flex-col gap-3 border-b pb-3">
      <DmRow />
      <GuildRow />
    </div>
  )
}

/**
 * The four most recent conversations, newest first (READY `lastMessageAt`, then each new
 * message). The fifth tile clusters the rest and opens the DM home; it is lit there and while a
 * DM that has no tile is open.
 */
function DmRow(): React.JSX.Element {
  const dms = useDmChannels()
  const lastAt = useUnreadStore((s) => s.lastAt)
  const row = useMemo(() => rowSlice(recentDms(dms, lastAt), true), [dms, lastAt])
  const inDms = useSelectedGuildId() === null
  const openDm = useNavStore((s) =>
    s.guildKey === DM_HOME ? (s.channelByGuild[DM_HOME] ?? null) : null
  )
  const channels = useChannelStore((s) => s.channels)
  const badge = useDmsUnread(row.hidden)
  const settings = useNavStore((s) => s.settings !== null)
  const here = inDms && !settings

  return (
    <TileRow
      label="Direct messages"
      add={{ label: 'New message', onClick: openDmHome }}
      ids={row.tiles}
      renderTile={(id) => <DmTile key={id} channelId={id} lit={here && openDm === id} />}
      cluster={
        <ClusterTile
          label="All direct messages"
          lit={here && (openDm === null || !row.tiles.includes(openDm))}
          badge={badge}
          onClick={openDmHome}
          stack={row.hidden.slice(0, 3).flatMap((id) => {
            const c = channels.get(id)
            return c
              ? [
                  <UserAvatar
                    key={id}
                    name={dmName(c)}
                    avatar={c.recipients?.[0]?.avatar}
                    size={18}
                  />
                ]
              : []
          })}
          fallback={<MessageCircle className="size-4" />}
        />
      }
    />
  )
}

/** The 28 px avatar of a DM tile, and the hole of the mobile presence dot on its corner. */
const DM_AVATAR = 28
const PRESENCE_HOLE = presenceHole(DM_AVATAR)

function DmTile({ channelId, lit }: { channelId: string; lit: boolean }): React.JSX.Element | null {
  const channel = useChannelStore((s) => s.channels.get(channelId))
  const other = channel?.recipients?.[0]
  const isGroup = channel?.type === 'group_dm'
  const status = useGuildStore((s) =>
    other && !isGroup ? (s.presences.get(other.id) ?? 'offline') : undefined
  )
  const badge = useChannelUnread(channelId)
  if (!channel) return null
  const name = dmName(channel)
  const mark = tileMark(badge, isGroup ? GROUP_BOX : DM_AVATAR, { dot: false })
  return (
    <Tile id={channelId} label={name} lit={lit} onClick={() => navigate({ kind: 'dm', channelId })}>
      <span
        className="relative flex"
        style={isGroup ? undefined : cutStyle([...(status ? [PRESENCE_HOLE] : []), ...mark.holes])}
      >
        {isGroup ? (
          <GroupTileAvatars channel={channel} lit={lit} cut={mark.holes} />
        ) : (
          <UserAvatar
            name={name}
            avatar={other?.avatar}
            size={DM_AVATAR}
            status={status}
            cutout={cn(tileSurface(lit), 'mobile:bg-transparent')}
          />
        )}
        <UnreadMark
          badge={badge}
          size="corner"
          dot={false}
          className={cn('-top-1.5 -right-2', mark.className)}
        />
      </span>
    </Tile>
  )
}

/** Two 20 px avatars in a 30 px box: the second (with a 1 px ring) at its bottom right. */
const GROUP_BOX = 30
const GROUP_SECOND_AT = 9

function GroupTileAvatars({
  channel,
  lit,
  cut
}: {
  channel: Channel
  lit: boolean
  /** The holes of the unread mark, in the box. */
  cut: readonly Hole[]
}): React.JSX.Element {
  const [a, b] = channel.recipients ?? []
  const second: Hole = [GROUP_SECOND_AT + 10, GROUP_SECOND_AT + 10, 11]
  return (
    <span className="relative block size-[30px]">
      <span className="absolute top-0 left-0 flex" style={cutStyle(b ? [second, ...cut] : cut)}>
        <UserAvatar name={a?.username ?? '?'} avatar={a?.avatar} size={20} />
      </span>
      {b && (
        <span
          className={cn(
            'absolute right-0 bottom-0 flex rounded-full p-px',
            tileSurface(lit),
            'mobile:bg-transparent'
          )}
          style={cutStyle(shiftHoles(cut, GROUP_SECOND_AT, GROUP_SECOND_AT))}
        >
          <UserAvatar name={b.username} avatar={b.avatar} size={20} />
        </span>
      )}
    </span>
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
      label="Guilds"
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
            stack={row.hidden.slice(0, 3).flatMap((id) => {
              const g = guilds.get(id)
              return g
                ? [<GuildTile key={id} guild={g} className="size-[18px] border-0 text-[7px]" />]
                : []
            })}
          />
        )
      }
    />
  )
}

/** The 28 px icon of a guild tile. */
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
            <GuildTile guild={guild} className="size-7 border-0 text-[11px]" />
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
