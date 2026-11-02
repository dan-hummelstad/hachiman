import { useMemo } from 'react'
import type { Channel } from '@hachiman/client'
import { CheckCheck, FileText, Hash, MessagesSquare, Paperclip, Users, Volume2 } from 'lucide-react'
import { decryptText } from '@/components/chat/decrypt-text'
import { messageSummary } from '@/components/chat/message-summary'
import { MessageTokens } from '@/components/chat/message-tokens'
import { UserAvatar } from '@/components/shell/user-avatar'
import { IconButton } from '@/components/ui/icon-button'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useMemberView } from '@/hooks/use-member'
import { tokenize } from '@/lib/mentions'
import { channelLabel } from '@/lib/model'
import { jumpToMessage, openChannelView } from '@/lib/navigation'
import { formatListTime } from '@/lib/time-format'
import { cn } from '@/lib/utils'
import { unreadService } from '@/services/UnreadService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import type { ChatMessage } from '@/stores/messagesStore'
import { useSelectedGuildId } from '@/stores/navStore'
import { useChannelUnread } from '@/stores/unreadStore'
import { useIsBlocked } from '@/stores/userStore'
import type { InboxEntry, InboxFilter } from './inbox-model'

const META = 'text-text-disabled font-mono text-[8.5px] uppercase'

const TABS: readonly { value: InboxFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'mentions', label: 'Mentions' },
  { value: 'unreads', label: 'Unreads' },
  { value: 'threads', label: 'Threads' }
]

/** The four filters of the inbox as one radio group: a segmented track (desktop) or a pill (phone). */
export function InboxTabs({
  value,
  onChange,
  counts,
  variant
}: {
  value: InboxFilter
  onChange: (value: InboxFilter) => void
  counts: Record<InboxFilter, number>
  variant: 'desktop' | 'mobile'
}): React.JSX.Element {
  const mobile = variant === 'mobile'
  return (
    <div
      role="radiogroup"
      aria-label="Show"
      className={cn(
        'bg-surface-sunken flex gap-[3px] p-[3px]',
        mobile ? 'rounded-pill h-[38px] w-full' : 'rounded-control h-8 shrink-0'
      )}
    >
      {TABS.map((t) => {
        const on = t.value === value
        return (
          <button
            key={t.value}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={`${t.label}, ${counts[t.value]}`}
            onClick={() => onChange(t.value)}
            className={cn(
              'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
              mobile
                ? 'rounded-pill h-8 flex-1 text-[12.5px] font-medium'
                : 'h-[26px] rounded-[4px] px-3 text-[12px] font-medium',
              on
                ? 'bg-here text-on-here font-semibold'
                : 'text-text-tertiary hover:text-text-secondary'
            )}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

/** A day heading of the desktop list: TODAY, YESTERDAY, EARLIER and a hairline. */
export function DayHead({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="mobile:hidden flex h-[34px] items-center gap-3">
      <span className="text-text-disabled font-mono text-[8.5px] tracking-[1.4px] uppercase">
        {children}
      </span>
      <span className="bg-line-hairline h-px flex-1" />
    </div>
  )
}

/** The end of the list. */
export function InboxEnd(): React.JSX.Element {
  return (
    <div className="flex h-[70px] items-center justify-center gap-[9px]">
      <CheckCheck aria-hidden className="text-text-disabled size-[15px]" />
      <span className="text-text-disabled font-mono text-[9px] tracking-[1.4px] uppercase">
        That is everything
      </span>
    </div>
  )
}

const EMPTY_TEXT: Record<InboxFilter, string> = {
  all: 'You are all caught up.',
  mentions: 'Nothing mentions you right now.',
  unreads: 'No channel has unread messages.',
  threads: 'No thread has news.'
}

export function InboxEmpty({ filter }: { filter: InboxFilter }): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <CheckCheck aria-hidden className="text-text-disabled size-[15px]" />
      <p className="text-text-secondary text-[14px] leading-5">{EMPTY_TEXT[filter]}</p>
    </div>
  )
}

/** The avatar of a channel entry: the other person of a 1:1 DM, else a tile with the type icon. */
function ChannelAvatar({ channel }: { channel: Channel }): React.JSX.Element {
  const recipient = channel.type === 'dm' ? channel.recipients?.[0] : undefined
  if (recipient) return <UserAvatar name={recipient.username} avatar={recipient.avatar} size={38} />
  const Icon =
    channel.type === 'pages'
      ? FileText
      : channel.type === 'voice'
        ? Volume2
        : channel.type === 'thread'
          ? MessagesSquare
          : channel.guildId === null
            ? Users
            : Hash
  return (
    <span className="bg-surface-raised text-text-tertiary mobile:rounded-full flex size-[38px] shrink-0 items-center justify-center rounded-[8px]">
      <Icon className="size-[18px]" />
    </span>
  )
}

/** The where line of a row: "GUILD · #channel", "GUILD · #parent › thread" or "DIRECT MESSAGE". */
function WhereLine({ channel }: { channel: Channel }): React.JSX.Element {
  const guild = useGuildStore((s) =>
    channel.guildId !== null ? s.guilds.get(channel.guildId)?.name : undefined
  )
  const selected = useSelectedGuildId()
  const parent = useChannelStore((s) =>
    channel.parentId ? s.channels.get(channel.parentId)?.name : undefined
  )
  const { sigil, name } = channelLabel(channel)
  const dm = channel.guildId === null
  const place = dm
    ? channel.type === 'dm'
      ? 'Direct message'
      : name
    : channel.type === 'thread' && parent
      ? `#${parent} › ${name}`
      : `${sigil}${name}`
  return (
    <span className={cn(META, 'flex min-w-0 items-center gap-[7px] tracking-[1px]')}>
      <span
        aria-hidden
        className={cn(
          'mobile:size-1.5 size-[7px] shrink-0 rounded-full',
          channel.guildId !== null && channel.guildId === selected ? 'bg-here' : 'bg-text-disabled'
        )}
      />
      <span className="truncate">
        {guild && <span className="mobile:hidden">{guild} · </span>}
        {place}
      </span>
    </span>
  )
}

/**
 * One inbox entry: a bar on the left (`you` for a mention), the avatar, two lines (where and who
 * and when; the message) and, on the right, the unread mark and Mark read. The whole row is one
 * button under the content, so links in the message stay out of the way of the tap and are not
 * nested in a button. `trailing` sits above it.
 */
function InboxRow({
  mention,
  label,
  onOpen,
  avatar,
  channel,
  author,
  at,
  trailing,
  children
}: {
  mention: boolean
  /** The accessible name of the row's button. */
  label: string
  onOpen: () => void
  avatar: React.ReactNode
  channel: Channel
  author?: React.ReactNode
  at: number | null
  trailing: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'relative flex min-h-[76px] items-center gap-3.5 rounded-[6px] border-l-[3px] pr-3.5 pl-[11px]',
        'mobile:min-h-[62px] mobile:gap-[11px] mobile:rounded-none mobile:border-b mobile:border-b-line-hairline mobile:py-3',
        mention ? 'bg-you-tint border-you' : 'border-line-strong'
      )}
    >
      <button
        type="button"
        aria-label={at !== null ? `${label}, ${formatListTime(at)}` : label}
        onClick={onOpen}
        className="hover:bg-surface-hover active:bg-surface-hover focus-visible:outline-line-focus absolute inset-0 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2"
      />
      <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3.5 mobile:gap-[11px]">
        <span className="mobile:[&_[data-slot=avatar]]:size-[34px] mobile:[&>span]:size-[34px] shrink-0">
          {avatar}
        </span>
        <div className="mobile:gap-1 flex min-w-0 flex-1 flex-col gap-[5px]">
          <div aria-hidden className="flex items-center gap-[7px]">
            <WhereLine channel={channel} />
            {author && (
              <span className="text-text-secondary mobile:text-[12px] min-w-0 truncate text-[12.5px] font-semibold">
                {author}
              </span>
            )}
            <span className="flex-1" />
            {at !== null && (
              <time
                dateTime={new Date(at).toISOString()}
                className={cn(META, 'shrink-0 tracking-[0.7px]')}
              >
                {formatListTime(at)}
              </time>
            )}
          </div>
          {children}
        </div>
      </div>
      <div className="relative flex shrink-0 items-center gap-3">{trailing}</div>
    </div>
  )
}

function Trailing({
  badge,
  channelId,
  title
}: {
  /** The entry's own badge; a mention row shows the counts of its channel. */
  badge?: { mentions: number; unread: boolean }
  channelId: string
  title: string
}): React.JSX.Element {
  const own = useChannelUnread(channelId)
  return (
    <>
      <UnreadMark badge={badge ?? own} />
      <IconButton
        size="sm"
        label={`Mark ${title} read`}
        onClick={() => unreadService.markChannelRead(channelId)}
        className="text-text-disabled hover:text-text-primary [&_svg]:size-4"
      >
        <CheckCheck />
      </IconButton>
    </>
  )
}

const MESSAGE = 'text-text-primary mobile:text-[13.5px] truncate text-[14px]'

export function MentionItem({
  entry,
  onNavigate
}: {
  entry: Extract<InboxEntry, { kind: 'mention' }>
  /** Called before the jump: the popover or the screen closes. */
  onNavigate: () => void
}): React.JSX.Element | null {
  const channel = useChannelStore((s) => s.channels.get(entry.channelId))
  if (!channel) return null
  const open = (): void => {
    onNavigate()
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
  const { name, avatar } = useMemberView(row.guildId, row.author.id, row.author)
  const blocked = useIsBlocked(row.author.id)
  const placeholder = blocked ? 'Blocked message' : decryptText(row.decrypt)
  const { sigil, name: channelName } = channelLabel(channel)
  // Every DM message counts as a mention (unread logic); its row says what it is.
  const dm = channel.guildId === null
  const verb = dm ? 'messaged you' : 'mentioned you'
  const title = dm ? channelName : `${sigil}${channelName}`
  return (
    <InboxRow
      mention
      label={`${name} ${verb} in ${title}`}
      onOpen={onOpen}
      avatar={<UserAvatar name={name} avatar={avatar} size={38} />}
      channel={channel}
      author={name}
      at={at}
      trailing={<Trailing channelId={channel.id} title={title} />}
    >
      {placeholder ? (
        <p className="text-text-tertiary mobile:text-[13.5px] truncate text-[14px] italic">
          {placeholder}
        </p>
      ) : (
        <InboxText message={row} />
      )}
    </InboxRow>
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
  const dm = channel.guildId === null
  const head = dm ? 'New message' : 'A message mentions you'
  const title = dm ? name : `${sigil}${name}`
  return (
    <InboxRow
      mention
      label={`${head} in ${title}`}
      onOpen={onOpen}
      avatar={<ChannelAvatar channel={channel} />}
      channel={channel}
      at={null}
      trailing={<Trailing channelId={channel.id} title={title} />}
    >
      <p className={MESSAGE}>{head}</p>
    </InboxRow>
  )
}

/** The message text with its tokens (one line), else what it carries. */
function InboxText({ message }: { message: ChatMessage }): React.JSX.Element | null {
  const { text, files, pageLink } = useMemo(() => messageSummary(message), [message])
  const tokens = useMemo(() => tokenize(text), [text])
  if (text !== '')
    return (
      <p className={MESSAGE}>
        <MessageTokens tokens={tokens} guildId={message.guildId} />
      </p>
    )
  if (files === null && !pageLink) return null
  return (
    <p className="text-text-secondary flex items-center gap-1 text-[13px]">
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

export function ChannelItem({
  entry,
  onNavigate
}: {
  entry: Extract<InboxEntry, { kind: 'channel' }>
  onNavigate: () => void
}): React.JSX.Element {
  const { channel } = entry
  const { sigil, name } = channelLabel(channel)
  const news = newsOf(entry)
  const title = `${sigil}${name}`
  return (
    <InboxRow
      mention={false}
      label={`${title}, ${news}`}
      onOpen={() => {
        onNavigate()
        openChannelView(channel)
      }}
      avatar={<ChannelAvatar channel={channel} />}
      channel={channel}
      at={entry.at}
      trailing={<Trailing badge={entry.badge} channelId={channel.id} title={title} />}
    >
      <p className={cn(MESSAGE, 'text-text-secondary')}>
        <span className="text-text-primary font-semibold">{title}</span> {news}
      </p>
    </InboxRow>
  )
}
