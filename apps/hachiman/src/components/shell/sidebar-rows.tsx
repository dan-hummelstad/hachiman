import { useMemo, useState } from 'react'
import { MessageCircle } from 'lucide-react'
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
import { UnreadMark } from '@/components/ui/unread-mark'
import { useDmChannels } from '@/hooks/use-hachiman'
import { dmName } from '@/lib/model'
import { dragged, orderedIds, recentDms, rowSlice, tileSurface } from '@/lib/sidebar-tiles'
import { cn } from '@/lib/utils'
import { openDialog } from '@/stores/dialogStore'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { DM_HOME, navigate, selectGuild, useNavStore, useSelectedGuildId } from '@/stores/navStore'
import { useGuildOrder, usePrefsStore } from '@/stores/prefsStore'
import {
  useChannelUnread,
  useDmsUnread,
  useGuildUnread,
  useGuildsUnread,
  useUnreadStore
} from '@/stores/unreadStore'

const NO_BADGE = { unread: false, mentions: 0 }

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
          stack={row.hidden.slice(0, 3).map((id) => {
            const c = channels.get(id)
            const who = c?.recipients?.[0]
            return c ? <UserAvatar name={dmName(c)} avatar={who?.avatar} size={18} /> : null
          })}
          fallback={<MessageCircle className="size-4" />}
        />
      }
    />
  )
}

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
  return (
    <Tile id={channelId} label={name} lit={lit} onClick={() => navigate({ kind: 'dm', channelId })}>
      <span className="relative flex">
        {isGroup ? (
          <GroupAvatars channel={channel} lit={lit} />
        ) : (
          <UserAvatar
            name={name}
            avatar={other?.avatar}
            size={28}
            status={status}
            cutout={tileSurface(lit)}
          />
        )}
        <UnreadMark badge={badge} size="corner" dot={false} className="-top-1.5 -right-2" />
      </span>
    </Tile>
  )
}

/** Two stacked avatars for a group DM: the first two recipients, offset diagonally. */
function GroupAvatars({ channel, lit }: { channel: Channel; lit: boolean }): React.JSX.Element {
  const [a, b] = channel.recipients ?? []
  return (
    <span className="relative block size-[30px]">
      <UserAvatar
        name={a?.username ?? '?'}
        avatar={a?.avatar}
        size={20}
        className="absolute top-0 left-0"
      />
      {b && (
        <span className={cn('absolute right-0 bottom-0 flex rounded-full p-px', tileSurface(lit))}>
          <UserAvatar name={b.username} avatar={b.avatar} size={20} />
        </span>
      )}
    </span>
  )
}

/**
 * The guilds in the user's order. Folded: the first four, then a cluster tile of the rest with
 * their badge (no cluster with five or fewer). The cluster opens a grid of every guild, five a
 * line, with a chevron in its place that folds it; Escape or a pick folds it too. Drag a tile to
 * reorder.
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

  const pick = (id: string): void => {
    selectGuild(id)
    setOpen(false)
  }
  const onMove = (fromId: string, toId: string): void => {
    const next = dragged(ids, fromId, toId)
    if (next) usePrefsStore.getState().setGuildOrder(next)
  }
  const n = row.hidden.length

  return (
    <TileRow
      label="Guilds"
      add={{ label: 'Create or join a guild', onClick: () => openDialog({ kind: 'addGuild' }) }}
      ids={expanded ? ids : row.tiles}
      renderTile={(id) => <GuildRowTile key={id} guildId={id} lit={current === id} onPick={pick} />}
      onMove={onMove}
      onEscape={expanded ? () => setOpen(false) : undefined}
      cluster={
        row.cluster && (
          <ClusterTile
            label={expanded ? 'Show fewer guilds' : `${n} more ${n === 1 ? 'guild' : 'guilds'}`}
            lit={!expanded && current !== null && row.hidden.includes(current)}
            badge={expanded ? NO_BADGE : badge}
            expanded={expanded}
            onClick={() => setOpen(!expanded)}
            stack={row.hidden.slice(0, 3).map((id) => {
              const g = guilds.get(id)
              return g ? <GuildTile guild={g} className="size-[18px] border-0 text-[7px]" /> : null
            })}
          />
        )
      }
    />
  )
}

/** A guild tile with its unread dot and mention sum (N7); right click: the guild menu. */
function GuildRowTile({
  guildId,
  lit,
  onPick
}: {
  guildId: string
  lit: boolean
  onPick: (guildId: string) => void
}): React.JSX.Element | null {
  const guild = useGuildStore((s) => s.guilds.get(guildId))
  const badge = useGuildUnread(guildId)
  if (!guild) return null
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Tile id={guildId} label={guild.name} lit={lit} onClick={() => onPick(guildId)}>
          <span className="relative flex">
            <GuildTile guild={guild} className="size-7 border-0 text-[11px]" />
            <UnreadMark badge={badge} size="corner" />
          </span>
        </Tile>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <GuildMenuItems guildId={guildId} Item={ContextMenuItem} Separator={ContextMenuSeparator} />
      </ContextMenuContent>
    </ContextMenu>
  )
}
