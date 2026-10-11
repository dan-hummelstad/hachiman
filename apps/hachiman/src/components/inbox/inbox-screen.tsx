import { useEffect, useId, useMemo, useState } from 'react'
import type { Channel } from '@hachiman/client'
import {
  AtSign,
  CheckCheck,
  FileText,
  Hash,
  MessageSquare,
  MessagesSquare,
  Paperclip,
  Users,
  Volume2
} from 'lucide-react'
import { create } from 'zustand'
import { decryptText } from '@/components/chat/decrypt-text'
import { messageSummary } from '@/components/chat/message-summary'
import { MessageTokens } from '@/components/chat/message-tokens'
import { closeDrawer, countLocalPushed } from '@/components/mobile/drawer-state'
import { FilterChips, type FilterChipOption } from '@/components/mobile/filter-chips'
import { ListGroup, SectionLabel } from '@/components/mobile/list'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { UserAvatar } from '@/components/shell/user-avatar'
import { FEATURE_TEXT, FEATURE_TILE } from '@/components/ui/feature'
import { GuildTile } from '@/components/ui/guild-tile'
import { IconButton } from '@/components/ui/icon-button'
import { useMemberView } from '@/hooks/use-member'
import { tokenize } from '@/lib/mentions'
import { channelLabel } from '@/lib/model'
import { jumpToMessage, openChannelView } from '@/lib/navigation'
import { formatListTime } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { unreadService } from '@/services/UnreadService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { currentView, sameView, useNavStore } from '@/stores/navStore'
import { useNotifyPrefs } from '@/stores/prefsStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useIsBlocked } from '@/stores/userStore'
import {
  filterInbox,
  inboxCounts,
  inboxEntries,
  mentionEntries,
  unreadGroups,
  type InboxEntry,
  type InboxFilter,
  type InboxKind
} from './inbox-model'

/** The time a closed screen stays mounted: the slide out (250) and a margin. */
const SLIDE_OUT_MS = 400

/**
 * Whether the inbox screen shows. A local overlay of the mobile layout, not a navStore view
 * (docs/ios-mobile-ui-spec.md §2.6). In memory only.
 */
const useInboxScreen = create<{ open: boolean }>()(() => ({ open: false }))

/** Opens the inbox screen over the chat. The left drawer, which holds the inbox button, closes. */
// eslint-disable-next-line react-refresh/only-export-components
export function openInboxScreen(): void {
  useInboxScreen.setState({ open: true })
  closeDrawer()
}

// eslint-disable-next-line react-refresh/only-export-components
export function closeInboxScreen(): void {
  useInboxScreen.setState({ open: false })
}

/** True while the inbox screen shows (the MobileShell makes the chat inert under it). */
// eslint-disable-next-line react-refresh/only-export-components
export const useInboxScreenOpen = (): boolean => useInboxScreen((s) => s.open)

/**
 * The inbox on a phone (M67, J4): a pushed screen with "n unread · all guilds" and Mark all read
 * in the Nav Bar, the filter chips All, Mentions and Channels (the popover's Unread tab), then one
 * list, newest first. A tap opens the message or the channel and closes the screen. It stays
 * mounted while it slides out; its data hooks run only while it is mounted.
 *
 * While it shows, the left edge swipe means Back and nothing in the chat counts as read
 * (`countLocalPushed`). A navigation from elsewhere (a call, a link) closes it.
 */
export function InboxScreen(): React.JSX.Element | null {
  const open = useInboxScreenOpen()
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)

  useEffect(() => {
    if (open || !present) return
    const t = setTimeout(() => setPresent(false), SLIDE_OUT_MS)
    return () => clearTimeout(t)
  }, [open, present])

  useEffect(() => {
    if (!open) return
    countLocalPushed(1)
    const from = currentView()
    const onView = (): void => {
      if (!sameView(from, currentView())) closeInboxScreen()
    }
    const offs = [useNavStore.subscribe(onView), useDocsStore.subscribe(onView)]
    return () => {
      offs.forEach((off) => off())
      countLocalPushed(-1)
    }
  }, [open])

  return present ? <InboxScreenBody open={open} /> : null
}

function useInboxEntries(): InboxEntry[] {
  const unread = useUnreadStore((s) => s.byChannel)
  const lastAt = useUnreadStore((s) => s.lastAt)
  const channels = useChannelStore((s) => s.channels)
  const messages = useMessageStore((s) => s.byChannel)
  const guilds = useGuildStore((s) => s.guilds)
  const prefs = useNotifyPrefs()
  return useMemo(
    () =>
      inboxEntries(
        mentionEntries(unread, messages, channels),
        unreadGroups(unread, channels, guilds, prefs).flatMap((g) => g.channels),
        lastAt
      ),
    [unread, messages, channels, guilds, prefs, lastAt]
  )
}

function InboxScreenBody({ open }: { open: boolean }): React.JSX.Element {
  const platform = usePlatform()
  const [filter, setFilter] = useState<InboxFilter>('all')
  const entries = useInboxEntries()
  const counts = useMemo(() => inboxCounts(entries), [entries])
  const shown = useMemo(() => filterInbox(entries, filter), [entries, filter])
  const options = useMemo<FilterChipOption<InboxFilter>[]>(
    () => [
      { value: 'all', label: 'All', count: counts.all },
      { value: 'mentions', label: 'Mentions', count: counts.mentions },
      { value: 'channels', label: 'Channels', count: counts.channels }
    ],
    [counts]
  )
  const listId = useId()

  const markAll = (): void => {
    if (unreadService.markAllRead() > 0) platform.haptic('success')
  }

  return (
    <PushedScreen
      open={open}
      title="Inbox"
      subtitle={counts.all > 0 ? `${counts.all} unread · all guilds` : 'All caught up'}
      onBack={closeInboxScreen}
      action={<MarkAllReadButton disabled={entries.length === 0} onClick={markAll} />}
      bodyClassName="pt-3"
    >
      <FilterChips
        type="single"
        label="Show"
        value={filter}
        onValueChange={setFilter}
        options={options}
        className="-mx-4 shrink-0 px-4"
      />
      {shown.length === 0 ? (
        <InboxEmpty filter={filter} />
      ) : (
        <section aria-labelledby={listId} className="flex flex-col gap-2.5">
          <SectionLabel id={listId}>Unread · {shown.length}</SectionLabel>
          <ListGroup>
            {shown.map((e) =>
              e.kind === 'channel' ? (
                <ChannelItem key={e.key} entry={e} />
              ) : (
                <MentionItem key={e.key} entry={e} />
              )
            )}
          </ListGroup>
        </section>
      )}
    </PushedScreen>
  )
}

/** The Nav Bar action of M67: 36 high, accent 15 %, check-check 16 and the label 13.5/700. */
function MarkAllReadButton({
  disabled,
  onClick
}: {
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-control inline-flex h-9 shrink-0 items-center gap-1.5 pr-3 pl-2.5 text-[13.5px] leading-4 font-bold whitespace-nowrap transition-colors',
        'bg-accent-primary/15 text-accent-text active:bg-accent-primary/30',
        'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      <CheckCheck aria-hidden className="size-4" />
      Mark all read
    </button>
  )
}

const EMPTY_TEXT: Record<InboxFilter, string> = {
  all: 'You are all caught up.',
  mentions: 'Nothing mentions you right now.',
  channels: 'No channel has unread messages.'
}

function InboxEmpty({ filter }: { filter: InboxFilter }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span
        aria-hidden
        className="bg-accent-tint text-accent-text flex size-12 items-center justify-center rounded-full"
      >
        <CheckCheck className="size-6" />
      </span>
      <p className="text-text-secondary text-[15px] leading-5 font-semibold">
        {EMPTY_TEXT[filter]}
      </p>
    </div>
  )
}

/** The 18 kind badge on the corner of the 36 avatar: gold @ for a mention, accent for a channel. */
const KIND_BADGE: Record<InboxKind, string> = {
  mention: 'bg-feature-event text-[#14151c]',
  channel: 'bg-accent-primary text-text-on-accent'
}

function KindAvatar({
  kind,
  children
}: {
  kind: InboxKind
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span aria-hidden className="relative size-9 shrink-0">
      {children}
      <span
        className={cn(
          'ring-surface-content absolute -right-[3px] -bottom-[3px] flex size-[18px] items-center justify-center rounded-full ring-2',
          KIND_BADGE[kind]
        )}
      >
        {kind === 'mention' ? (
          <AtSign className="size-2.5" strokeWidth={3} />
        ) : (
          <MessageSquare className="size-2.5" strokeWidth={3} />
        )}
      </span>
    </span>
  )
}

/**
 * The 36 avatar of a channel: the other person of a 1:1 DM, else a round tile with the type icon in
 * its feature colour (people for a group DM).
 */
function ChannelAvatar({ channel }: { channel: Channel }): React.JSX.Element {
  const recipient = channel.type === 'dm' ? channel.recipients?.[0] : undefined
  if (recipient) return <UserAvatar name={recipient.username} avatar={recipient.avatar} size={36} />
  const [Icon, tone] =
    channel.type === 'pages'
      ? [FileText, FEATURE_TILE.page]
      : channel.type === 'voice'
        ? [Volume2, FEATURE_TILE.voice]
        : channel.type === 'thread'
          ? [MessagesSquare, FEATURE_TILE.thread]
          : channel.guildId === null
            ? [Users, 'bg-surface-hover text-text-secondary']
            : [Hash, 'bg-surface-hover text-text-secondary']
  return (
    <span className={cn('flex size-9 items-center justify-center rounded-full', tone)}>
      <Icon className="size-[18px]" />
    </span>
  )
}

/**
 * Where an entry is: the guild mark, the channel ("#general", or the voice or page icon and its
 * name) and the guild name. `channelName` false: only the guild (a channel entry has its name in
 * the head). A DM says "Direct message"; a group DM its name.
 */
function Where({
  channel,
  channelName
}: {
  channel: Channel
  channelName: boolean
}): React.JSX.Element {
  const guild = useGuildStore((s) =>
    channel.guildId !== null ? s.guilds.get(channel.guildId) : undefined
  )
  const { sigil, name } = channelLabel(channel)
  if (channel.guildId === null)
    return <span className="truncate">{channel.type === 'dm' ? 'Direct message' : name}</span>
  const icon =
    channel.type === 'voice' ? (
      <Volume2 className={cn('size-[13px] shrink-0', FEATURE_TEXT.voice)} />
    ) : channel.type === 'pages' ? (
      <FileText className={cn('size-[13px] shrink-0', FEATURE_TEXT.page)} />
    ) : null
  return (
    <>
      {guild && (
        <GuildTile
          guild={guild}
          className="size-[15px] shrink-0 rounded-[3px] border-0 text-[6.5px] font-bold"
        />
      )}
      {channelName && icon}
      <span className="truncate">
        {channelName && `${icon ? '' : sigil}${name}`}
        {channelName && guild && ' · '}
        {guild?.name}
      </span>
    </>
  )
}

/**
 * One inbox entry (M67): the 36 avatar with its kind badge, the head (who and what, the time, the
 * unread dot), the context line and the message. The whole row is one button under the content,
 * so links and channel refs in the message stay out of the way of the tap and are not nested in
 * a button. `trailing` sits above it (Mark read).
 */
function ItemRow({
  label,
  onOpen,
  avatar,
  head,
  at,
  where,
  trailing,
  children
}: {
  /** The accessible name of the row's button. */
  label: string
  onOpen: () => void
  avatar: React.ReactNode
  head: React.ReactNode
  at: number | null
  where: React.ReactNode
  trailing?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="bg-accent-primary/6 relative flex items-center gap-1 p-3">
      <button
        type="button"
        aria-label={at !== null ? `${label}, ${formatListTime(at)}` : label}
        onClick={onOpen}
        className="active:bg-surface-hover focus-visible:outline-line-focus absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-1 gap-3 self-start">
        {avatar}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div aria-hidden className="flex items-center gap-2">
            <p className="text-text-primary min-w-0 flex-1 truncate text-[14.5px] leading-[18px]">
              {head}
            </p>
            {at !== null && (
              <time
                dateTime={new Date(at).toISOString()}
                className="text-text-tertiary shrink-0 text-[12px] leading-4 font-medium"
              >
                {formatListTime(at)}
              </time>
            )}
            <span className="bg-accent-primary size-2 shrink-0 rounded-full" />
          </div>
          <p
            aria-hidden
            className="text-text-tertiary flex min-w-0 items-center gap-1.5 text-[12.5px] leading-4 font-semibold"
          >
            {where}
          </p>
          {children}
        </div>
      </div>
      {trailing && <div className="relative shrink-0">{trailing}</div>}
    </div>
  )
}

function MentionItem({
  entry
}: {
  entry: Extract<InboxEntry, { kind: 'mention' }>
}): React.JSX.Element | null {
  const channel = useChannelStore((s) => s.channels.get(entry.channelId))
  if (!channel) return null
  const open = (): void => {
    closeInboxScreen()
    jumpToMessage(channel, entry.messageId)
  }
  return entry.row ? (
    <LoadedMention row={entry.row} channel={channel} at={entry.at} onOpen={open} />
  ) : (
    <UnloadedMention channel={channel} onOpen={open} />
  )
}

function LoadedMention({
  row,
  channel,
  at,
  onOpen
}: {
  row: ChatMessage
  channel: Channel
  at: number | null
  onOpen: () => void
}): React.JSX.Element {
  const { name, avatar, ink } = useMemberView(row.guildId, row.author.id, row.author)
  const blocked = useIsBlocked(row.author.id)
  const placeholder = blocked ? 'Blocked message' : decryptText(row.decrypt)
  const { sigil, name: channelName } = channelLabel(channel)
  return (
    <ItemRow
      label={`${name} mentioned you in ${sigil}${channelName}`}
      onOpen={onOpen}
      avatar={
        <KindAvatar kind="mention">
          <UserAvatar name={name} avatar={avatar} size={36} color={ink} />
        </KindAvatar>
      }
      head={
        <>
          <span className="font-extrabold" style={ink ? { color: ink } : undefined}>
            {name}
          </span>{' '}
          <span className="font-semibold">mentioned you</span>
        </>
      }
      at={at}
      where={<Where channel={channel} channelName />}
    >
      {placeholder ? (
        <p className="text-text-tertiary text-[14px] leading-5 font-medium italic">{placeholder}</p>
      ) : (
        <InboxText message={row} />
      )}
    </ItemRow>
  )
}

/** A mention whose message is not loaded: the channel's avatar, and no author or text. */
function UnloadedMention({
  channel,
  onOpen
}: {
  channel: Channel
  onOpen: () => void
}): React.JSX.Element {
  const { sigil, name } = channelLabel(channel)
  return (
    <ItemRow
      label={`A message mentions you in ${sigil}${name}`}
      onOpen={onOpen}
      avatar={
        <KindAvatar kind="mention">
          <ChannelAvatar channel={channel} />
        </KindAvatar>
      }
      head={<span className="font-semibold">A message mentions you</span>}
      at={null}
      where={<Where channel={channel} channelName />}
    />
  )
}

/** The message text with its tokens (three lines), else what it carries. */
function InboxText({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const { text, files, pageLink } = useMemo(() => messageSummary(message), [message])
  const tokens = useMemo(() => tokenize(text), [text])
  if (text !== '')
    return (
      <p className="text-text-primary line-clamp-3 text-[14px] leading-5 font-medium break-words whitespace-pre-wrap">
        <MessageTokens tokens={tokens} guildId={message.guildId} />
      </p>
    )
  if (files === null && !pageLink) return null
  return (
    <p className="text-text-secondary flex items-center gap-1 text-[13px] leading-4 font-semibold">
      {files !== null ? (
        <Paperclip aria-hidden className="size-3.5 shrink-0" />
      ) : (
        <FileText aria-hidden className="size-3.5 shrink-0" />
      )}
      <span className="truncate">{files ?? 'Page link'}</span>
    </p>
  )
}

/** "3 new", or the mentions of a muted channel (its badge shows no new messages). */
function newsOf(entry: Extract<InboxEntry, { kind: 'channel' }>): string {
  if (entry.badge.unread) return `${entry.unread > 99 ? '99+' : entry.unread} new`
  const n = entry.badge.mentions
  return `${n} ${n === 1 ? 'mention' : 'mentions'}`
}

function ChannelItem({
  entry
}: {
  entry: Extract<InboxEntry, { kind: 'channel' }>
}): React.JSX.Element {
  const { channel } = entry
  const { sigil, name } = channelLabel(channel)
  const news = newsOf(entry)
  const title = `${sigil}${name}`
  return (
    <ItemRow
      label={`${title}, ${news}`}
      onOpen={() => {
        closeInboxScreen()
        openChannelView(channel)
      }}
      avatar={
        <KindAvatar kind="channel">
          <ChannelAvatar channel={channel} />
        </KindAvatar>
      }
      head={
        <>
          <span className="font-extrabold">{title}</span>{' '}
          <span className="text-text-secondary font-semibold">{news}</span>
        </>
      }
      at={entry.at}
      where={<Where channel={channel} channelName={false} />}
      trailing={
        <IconButton
          size="touch"
          label={`Mark ${title} read`}
          onClick={() => unreadService.markChannelRead(channel.id)}
          className="text-text-secondary"
        >
          <CheckCheck />
        </IconButton>
      }
    />
  )
}
