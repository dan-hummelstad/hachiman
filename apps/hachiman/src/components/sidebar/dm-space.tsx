import { useMemo, useState } from 'react'
import { ChevronDown, Plus, SquarePen, Users } from 'lucide-react'
import type { Channel, PresenceStatus, VoiceState } from '@hachiman/client'
import { closeDrawer } from '@/components/mobile/drawer-state'
import { NewMessageDialog } from '@/components/people/new-message-dialog'
import { useOnlinePeople } from '@/components/people/use-people'
import { GroupAvatars } from '@/components/shell/sidebar-rows'
import { PinToTabsMenuItem } from '@/components/shell/tab-bar'
import { UserAvatar } from '@/components/shell/user-avatar'
import { openDmHome, sidebarRowClass } from '@/components/sidebar/sidebar-row'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { IconButton } from '@/components/ui/icon-button'
import { selectableRowClass } from '@/components/ui/selectable-row'
import { SystemTag } from '@/components/ui/system-tag'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useDmChannels } from '@/hooks/use-hachiman'
import { useLayout } from '@/hooks/use-layout'
import { useOnlineCount } from '@/hooks/use-online-count'
import { dmName } from '@/lib/model'
import type { UnreadBadge } from '@/lib/notify'
import { recentDms } from '@/lib/sidebar-tiles'
import { formatListTime } from '@/lib/time-format'
import { TOUCH_HIT } from '@/lib/touch'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { selectChannel, useSelectedChannelId } from '@/stores/navStore'
import { useChannelUnread, useDmUnread, useUnreadStore } from '@/stores/unreadStore'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * The look of the DM list: `sidebar` (the desktop sidebar, E2), `drawer` (the sidebar drawer on a
 * phone, M8: rows 48, avatar 30) and `home` (the mobile DM home, M56: rows 58, avatar 40 and a
 * column with the time and the count or LIVE). The two mobile looks list the conversations newest
 * first; the desktop keeps its order (spec §6.1 decision 3).
 */
export type DmListVariant = 'sidebar' | 'drawer' | 'home'

/**
 * The middle of the sidebar in the DM space (E1–E3): the "Direct messages" header with "New
 * message", the People row with the online count, and the conversations. In the mobile drawer
 * (M8) the conversations are a category row with "+", and "New message" opens its sheet.
 */
export function DmSpace(): React.JSX.Element {
  return useLayout() === 'mobile' ? <DrawerDmSpace /> : <SidebarDmSpace />
}

function SidebarDmSpace(): React.JSX.Element {
  const selectedChannelId = useSelectedChannelId()
  const online = useOnlineCount(null)
  const dmBadge = useDmUnread()

  return (
    <>
      <div className="flex h-[26px] shrink-0 items-center px-3">
        <h2 className="cap min-w-0 flex-1 truncate">Direct messages</h2>
        <IconButton
          size="sm"
          label="New message"
          onClick={openDmHome}
          className="text-text-disabled size-5 rounded-control"
        >
          <SquarePen className="size-[13px]" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-0.5 pb-2">
        <button
          type="button"
          onClick={openDmHome}
          aria-current={selectedChannelId === null ? 'page' : undefined}
          className={sidebarRowClass(selectedChannelId === null)}
        >
          <Users className="text-text-disabled size-3.5 shrink-0" />
          <span
            className={cn(
              'flex-1 truncate',
              dmBadge.unread && selectedChannelId !== null && 'text-text-primary font-semibold'
            )}
          >
            People
          </span>
          <span className="cap-sm">{online} online</span>
          <UnreadMark badge={dmBadge} dot={false} />
        </button>
        <h3 className="cap-sm flex h-7 items-center px-2.5 pt-2 tracking-[1.3px]">Conversations</h3>
        <DmList />
      </div>
    </>
  )
}

/**
 * The DM space in the sidebar drawer (M8). A navigation to the DM home keeps the drawer open (a
 * space switch), so the People row closes it itself; "New message" closes it for its sheet.
 */
function DrawerDmSpace(): React.JSX.Element {
  const selectedChannelId = useSelectedChannelId()
  const online = useOnlinePeople().length
  const dmBadge = useDmUnread()
  const [composing, setComposing] = useState(false)
  const [folded, setFolded] = useState(false)
  const home = selectedChannelId === null

  const newMessage = (): void => {
    closeDrawer()
    setComposing(true)
  }
  const openPeople = (): void => {
    openDmHome()
    closeDrawer()
  }

  return (
    <>
      <div className="flex h-9 shrink-0 items-center gap-2 pr-1 pl-4">
        <h2 className="text-text-primary min-w-0 flex-1 truncate text-[15px] leading-[18px] font-semibold">
          Direct messages
        </h2>
        <IconButton
          label="New message"
          onClick={newMessage}
          className={cn('text-text-tertiary size-[26px] rounded-[7px]', TOUCH_HIT)}
        >
          <SquarePen className="size-[15px]" />
        </IconButton>
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto px-3 pb-2">
        <button
          type="button"
          onClick={openPeople}
          aria-current={home ? 'page' : undefined}
          className={sidebarRowClass(
            home,
            'mobile:h-10 mobile:text-[13.5px] mobile:font-semibold'
          )}
        >
          <Users className="text-text-secondary size-[18px] shrink-0" />
          <span
            className={cn(
              'flex-1 truncate',
              dmBadge.unread && !home && 'text-text-primary mobile:font-semibold'
            )}
          >
            People
          </span>
          <span className="cap-sm">{online} online</span>
          <UnreadMark badge={dmBadge} dot={false} />
        </button>
        <div className="mt-0.5 flex h-9 items-center pr-1">
          <h3 className="flex h-full min-w-0 flex-1">
            <button
              type="button"
              onClick={() => setFolded(!folded)}
              aria-expanded={!folded}
              className="cap-sm flex h-full min-w-0 flex-1 items-center gap-1 pl-1 text-left tracking-[1.3px]"
            >
              <ChevronDown
                className={cn('size-3 shrink-0 transition-transform', folded && '-rotate-90')}
              />
              <span className="truncate">Conversations</span>
            </button>
          </h3>
          <IconButton
            size="sm"
            label="New message"
            onClick={newMessage}
            className={cn(
              "text-text-disabled rounded-control [&_svg:not([class*='size-'])]:size-4",
              TOUCH_HIT
            )}
          >
            <Plus />
          </IconButton>
        </div>
        {!folded && <DmList variant="drawer" />}
      </div>
      <NewMessageDialog open={composing} onClose={() => setComposing(false)} />
    </>
  )
}

/** The DM and group DM rows: avatar, name, the last decrypted message and LIVE. */
export function DmList({ variant = 'sidebar' }: { variant?: DmListVariant }): React.JSX.Element {
  const dms = useDmChannels()
  const selectedChannelId = useSelectedChannelId()
  const recent = variant !== 'sidebar'
  // The desktop list keeps its order, so it does not follow the activity times.
  const lastAt = useUnreadStore((s) => (recent ? s.lastAt : null))
  const ordered = useMemo(() => {
    if (!lastAt) return dms
    const byId = new Map(dms.map((c) => [c.id, c]))
    return recentDms(dms, lastAt).flatMap((id) => byId.get(id) ?? [])
  }, [dms, lastAt])

  if (dms.length === 0)
    return (
      <p
        className={cn(
          'text-text-tertiary py-1 text-xs',
          variant === 'home' ? 'px-4 text-[13.5px]' : 'px-2.5'
        )}
      >
        No conversations yet.
      </p>
    )
  return (
    <ul className={cn('flex flex-col', variant !== 'home' && 'gap-px')}>
      {ordered.map((c) =>
        variant === 'sidebar' ? (
          <DmRow key={c.id} channel={c} selected={selectedChannelId === c.id} />
        ) : (
          <TouchDmRow
            key={c.id}
            channel={c}
            selected={selectedChannelId === c.id}
            home={variant === 'home'}
          />
        )
      )}
    </ul>
  )
}

/** What a DM row shows, for both looks. */
function useDmRow(channel: Channel): {
  isGroup: boolean
  name: string
  avatar: string | null | undefined
  status: PresenceStatus | undefined
  preview: string | null
  /** The voice channel where the other person of a 1:1 streams, or null. */
  streamIn: string | null
  badge: UnreadBadge
} {
  const isGroup = channel.type === 'group_dm'
  const other = channel.recipients?.[0]
  const status = useGuildStore((s) =>
    other ? (s.presences.get(other.id) ?? 'offline') : undefined
  )
  const preview = useMessageStore((s) => previewOf(s.byChannel.get(channel.id), isGroup))
  const streamIn = useVoiceStore((s) =>
    other && !isGroup ? streamChannelOf(s.voiceStates, other.id) : null
  )
  const badge = useChannelUnread(channel.id)
  return {
    isGroup,
    name: dmName(channel),
    avatar: other?.avatar,
    status,
    preview,
    streamIn,
    badge
  }
}

function DmRow({ channel, selected }: { channel: Channel; selected: boolean }): React.JSX.Element {
  const { isGroup, name, avatar, status, preview, streamIn, badge } = useDmRow(channel)
  const unread = badge.unread && !selected

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li>
          <button
            type="button"
            onClick={() => selectChannel(channel.id)}
            aria-current={selected ? 'page' : undefined}
            className={sidebarRowClass(selected, 'h-8 gap-[9px] px-2 pl-2 font-normal')}
            title={preview ?? undefined}
          >
            <UserAvatar
              name={name}
              avatar={avatar}
              size={20}
              status={isGroup ? undefined : status}
              cutout="bg-surface-panel"
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                unread || selected ? 'text-text-primary font-semibold' : 'text-text-secondary'
              )}
            >
              {name}
            </span>
            {streamIn !== null && <SystemTag kind="live" />}
            <UnreadMark badge={badge} dot={false} />
          </button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <PinToTabsMenuItem view={{ kind: 'dm', channelId: channel.id }} />
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** The touch looks of a DM row (`drawer`, M8, and `home`, M56). */
const TOUCH_LOOK = {
  drawer: {
    avatar: 30,
    group: 30,
    row: 'h-12 gap-2.5 px-2 active:bg-surface-hover',
    text: 'gap-px',
    name: 'text-[13.5px] leading-[17px]',
    line: 'text-xs leading-[14px]'
  },
  home: {
    avatar: 40,
    group: 40,
    row: 'h-[58px] gap-3 px-4 active:bg-surface-hover',
    text: 'gap-0.5',
    name: 'text-[15.5px] leading-[19px]',
    line: 'text-[13.5px] leading-4'
  }
} as const

/**
 * A DM row on the phone. The second line is the last decrypted message, or "Streaming <channel>"
 * in `live` teal while the other person of a 1:1 streams (with the purple dot). A hold opens the row
 * menu as a sheet. On the DM home the end column has the time of the last message over the count,
 * or LIVE.
 */
function TouchDmRow({
  channel,
  selected,
  home
}: {
  channel: Channel
  selected: boolean
  home: boolean
}): React.JSX.Element {
  const { isGroup, name, avatar, status, preview, streamIn, badge } = useDmRow(channel)
  const streamName = useChannelStore((s) =>
    streamIn !== null ? (s.channels.get(streamIn)?.name ?? null) : null
  )
  const lastAt = useUnreadStore((s) => (home ? s.lastAt.get(channel.id) : undefined))
  const look = TOUCH_LOOK[home ? 'home' : 'drawer']
  const unread = badge.unread && !selected
  const live = streamIn !== null
  const line = live ? `Streaming ${streamName ?? 'now'}` : preview

  const nameClass = home
    ? cn('text-text-primary', unread ? 'font-semibold' : 'font-medium')
    : cn(
        selected || unread ? 'text-text-primary' : 'text-text-secondary',
        unread || selected ? 'font-semibold' : 'font-normal'
      )
  const lineClass = live
    ? 'text-live-text'
    : home && unread
      ? 'text-text-primary font-semibold'
      : 'text-text-tertiary'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <li>
          <button
            type="button"
            onClick={() => selectChannel(channel.id)}
            aria-current={selected ? 'page' : undefined}
            className={
              home
                ? cn('flex w-full items-center text-left', look.row)
                : selectableRowClass(selected, cn('flex w-full items-center text-left', look.row))
            }
          >
            {isGroup ? (
              <GroupAvatars channel={channel} size={look.group} />
            ) : (
              <UserAvatar
                name={name}
                avatar={avatar}
                size={look.avatar}
                status={status}
                live={live}
                ringHole
              />
            )}
            <span className={cn('flex min-w-0 flex-1 flex-col', look.text)}>
              <span className={cn('truncate', look.name, nameClass)}>{name}</span>
              {line && <span className={cn('truncate', look.line, lineClass)}>{line}</span>}
            </span>
            {home ? (
              <span className="flex shrink-0 flex-col items-end gap-[5px]">
                {live ? (
                  <SystemTag kind="live" />
                ) : (
                  <>
                    {lastAt !== undefined && (
                      <span
                        className={cn(
                          'font-mono text-[10px] leading-[14px] tabular-nums',
                          unread ? 'text-you-text' : 'text-text-tertiary'
                        )}
                      >
                        {formatListTime(lastAt)}
                      </span>
                    )}
                    <UnreadMark badge={badge} dot={false} />
                  </>
                )}
              </span>
            ) : (
              <>
                {live && <SystemTag kind="live" />}
                <UnreadMark badge={badge} dot={false} />
              </>
            )}
          </button>
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={name}>
        <PinToTabsMenuItem view={{ kind: 'dm', channelId: channel.id }} />
      </ContextMenuContent>
    </ContextMenu>
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

function streamChannelOf(
  voiceStates: ReadonlyMap<string, ReadonlyMap<string, VoiceState>>,
  userId: string
): string | null {
  for (const states of voiceStates.values()) {
    const state = states.get(userId)
    if (state?.selfStream && state.channelId) return state.channelId
  }
  return null
}
