import { useMemo, useState } from 'react'
import { AtSign, CheckCheck, Inbox } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { EmptyLine } from '@/components/pins/header-count-button'
import { jumpToMessage, openChannelView } from '@/lib/navigation'
import { MessagePreview } from '@/components/pins/message-preview'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { channelLabel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { unreadService } from '@/services/UnreadService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useMessageStore } from '@/stores/messagesStore'
import { useNotifyPrefs } from '@/stores/prefsStore'
import { useAnyMention, useUnreadStore } from '@/stores/unreadStore'
import { mentionEntries, unreadGroups, type MentionEntry, type UnreadGroup } from './inbox-model'

type Tab = 'mentions' | 'unread'

/**
 * The inbox button of the sidebar top (N8): an inbox icon with a red dot while anything mentions
 * me, opening `MentionsInbox`. Not the E2EE device inbox of ds-transport.ts.
 */
export function InboxButton({ className }: { className?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const mentioned = useAnyMention()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label={mentioned ? 'Inbox, new mentions' : 'Inbox'}
          tooltipSide="bottom"
          pressed={open}
          className={cn(
            'text-text-secondary hover:bg-surface-hover hover:text-text-primary relative [&_svg]:size-[18px]',
            className
          )}
        >
          <Inbox />
          {mentioned && (
            <span
              aria-hidden
              className="bg-feature-danger ring-surface-panel absolute top-1 right-1 size-2 rounded-full ring-2"
            />
          )}
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[420px] max-w-[calc(100vw-32px)] p-0">
        <MentionsInbox onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The inbox popover: Mentions (newest first, across channels) and Unread (by guild). */
export function MentionsInbox({ onNavigate }: { onNavigate: () => void }): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('mentions')
  const unread = useUnreadStore((s) => s.byChannel)
  const channels = useChannelStore((s) => s.channels)
  const messages = useMessageStore((s) => s.byChannel)
  const guilds = useGuildStore((s) => s.guilds)
  const prefs = useNotifyPrefs()
  const mentions = useMemo(
    () => mentionEntries(unread, messages, channels),
    [unread, messages, channels]
  )
  const groups = useMemo(
    () => unreadGroups(unread, channels, guilds, prefs),
    [unread, channels, guilds, prefs]
  )
  const unreadCount = groups.reduce((n, g) => n + g.channels.length, 0)

  return (
    <div className="flex max-h-[min(600px,75vh)] flex-col">
      <header className="border-line-hairline flex shrink-0 items-center gap-2 border-b p-2">
        <SegmentedControl
          label="Inbox"
          className="flex-1"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'mentions', label: 'Mentions', count: mentions.length },
            { value: 'unread', label: 'Unread', count: unreadCount }
          ]}
        />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tab === 'mentions' ? (
          <MentionList entries={mentions} channels={channels} onNavigate={onNavigate} />
        ) : (
          <UnreadList groups={groups} onNavigate={onNavigate} />
        )}
      </div>
    </div>
  )
}

function MentionList({
  entries,
  channels,
  onNavigate
}: {
  entries: MentionEntry[]
  channels: ReadonlyMap<string, Channel>
  onNavigate: () => void
}): React.JSX.Element {
  if (entries.length === 0) return <EmptyLine>Nothing mentions you right now.</EmptyLine>
  return (
    <>
      {entries.map((e) => {
        const channel = channels.get(e.channelId)!
        const jump = (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              onNavigate()
              jumpToMessage(channel, e.messageId)
            }}
          >
            Jump
          </Button>
        )
        const where = <ChannelLine channel={channel} />
        return e.row ? (
          <MessagePreview key={e.messageId} message={e.row} context={where} actions={jump} />
        ) : (
          <div key={e.messageId} className="flex items-center gap-3 px-2.5 py-2">
            <span className="rounded-pill bg-feature-event/15 text-feature-event-text flex size-8 shrink-0 items-center justify-center">
              <AtSign className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              {where}
              <p className="text-text-secondary text-[13px]">A message mentions you.</p>
            </div>
            {jump}
          </div>
        )
      })}
    </>
  )
}

function ChannelLine({ channel }: { channel: Channel }): React.JSX.Element {
  const { sigil, name } = channelLabel(channel)
  const guild = useGuildStore((s) =>
    channel.guildId ? s.guilds.get(channel.guildId)?.name : undefined
  )
  return (
    <p className="text-text-tertiary truncate text-[11.5px] font-bold">
      {sigil}
      {name}
      {guild && ` · ${guild}`}
    </p>
  )
}

function UnreadList({
  groups,
  onNavigate
}: {
  groups: UnreadGroup[]
  onNavigate: () => void
}): React.JSX.Element {
  if (groups.length === 0) return <EmptyLine>You are all caught up.</EmptyLine>
  return (
    <>
      {groups.map((g) => (
        <section key={g.guildId ?? '@me'} className="pb-1">
          <h3 className="section-label px-2.5 pt-2 pb-1">{g.name}</h3>
          {g.channels.map(({ channel, badge }) => (
            <div
              key={channel.id}
              className="rounded-option hover:bg-surface-hover flex items-center gap-2 px-2.5 py-1"
            >
              <button
                type="button"
                onClick={() => {
                  onNavigate()
                  openChannelView(channel)
                }}
                className={cn(
                  'text-text-primary min-w-0 flex-1 truncate py-1 text-left text-[14px] font-semibold',
                  'focus-visible:outline-line-focus rounded-control outline-none focus-visible:outline-2'
                )}
              >
                {channelLabel(channel).sigil}
                {channelLabel(channel).name}
              </button>
              {badge.mentions > 0 && (
                <span className="bg-feature-danger text-text-on-accent rounded-pill min-w-5 px-1.5 text-center text-[11px] leading-5 font-bold">
                  {badge.mentions}
                </span>
              )}
              <Button
                variant="quiet"
                size="sm"
                onClick={() => unreadService.markChannelRead(channel.id)}
              >
                <CheckCheck />
                Mark read
              </Button>
            </div>
          ))}
        </section>
      ))}
    </>
  )
}
