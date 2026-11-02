import { useMemo, useState } from 'react'
import { Inbox } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { UnreadMark } from '@/components/ui/unread-mark'
import { useLayout } from '@/hooks/use-layout'
import { cn } from '@/lib/utils'
import { unreadService } from '@/services/UnreadService'
import { useChannelStore } from '@/stores/channelStore'
import { useAnyMention } from '@/stores/unreadStore'
import { dayGroups, filterInbox, inboxCounts, type InboxFilter } from './inbox-model'
import { DayHead, InboxEmpty, InboxEnd, InboxTabs, ChannelItem, MentionItem } from './inbox-rows'
import { openInboxScreen, spacesOf, useInboxEntries } from './inbox-screen'

const ANY_MENTION = { mentions: 1, unread: true }
const NO_MENTION = { mentions: 0, unread: false }

const BUTTON =
  'text-text-tertiary hover:bg-surface-hover hover:text-text-primary relative [&_svg]:size-[15px] mobile:[&_svg]:size-[18px]'

/**
 * The inbox button of the sidebar top (N8): an inbox icon with a red dot while anything mentions
 * me. On the desktop layout it opens `MentionsInbox` in a popover; on the mobile layout the inbox
 * screen (M67). Not the E2EE device inbox of ds-transport.ts.
 */
export function InboxButton({ className }: { className?: string }): React.JSX.Element {
  return useLayout() === 'mobile' ? (
    <MobileInboxButton className={className} />
  ) : (
    <DesktopInboxButton className={className} />
  )
}

function InboxGlyph({ mentioned }: { mentioned: boolean }): React.JSX.Element {
  return (
    <>
      <Inbox />
      <UnreadMark
        badge={mentioned ? ANY_MENTION : NO_MENTION}
        size="corner"
        count={false}
        aria-hidden
        className="ring-surface-panel top-1 right-1 size-2"
      />
    </>
  )
}

function DesktopInboxButton({ className }: { className?: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const mentioned = useAnyMention()
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <IconButton
          label={mentioned ? 'Inbox, new mentions' : 'Inbox'}
          tooltipSide="bottom"
          pressed={open}
          className={cn(BUTTON, className)}
        >
          <InboxGlyph mentioned={mentioned} />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[600px] max-w-[calc(100vw-32px)] p-0">
        <MentionsInbox onNavigate={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  )
}

/** The mobile button: it opens the inbox screen, which MobileShell renders in its root. */
function MobileInboxButton({ className }: { className?: string }): React.JSX.Element {
  const mentioned = useAnyMention()
  return (
    <IconButton
      label={mentioned ? 'Inbox, new mentions' : 'Inbox'}
      onClick={openInboxScreen}
      className={cn(BUTTON, className)}
    >
      <InboxGlyph mentioned={mentioned} />
    </IconButton>
  )
}

/** The inbox popover (N3): the header with the counts, the four tabs and Mark all read, then the days. */
export function MentionsInbox({ onNavigate }: { onNavigate: () => void }): React.JSX.Element {
  const [filter, setFilter] = useState<InboxFilter>('all')
  const entries = useInboxEntries()
  const channels = useChannelStore((s) => s.channels)
  const counts = useMemo(() => inboxCounts(entries), [entries])
  const shown = useMemo(() => filterInbox(entries, filter), [entries, filter])
  const days = useMemo(() => dayGroups(shown, Date.now()), [shown])
  const spaces = useMemo(() => spacesOf(shown, channels), [shown, channels])

  return (
    <div className="flex max-h-[min(720px,80vh)] flex-col">
      <header className="border-line-hairline flex h-[72px] shrink-0 items-center gap-3.5 border-b px-5">
        <div className="flex flex-col gap-1">
          <h2 className="text-[20px] leading-none font-semibold tracking-[-0.5px]">Inbox</h2>
          <p className="text-text-disabled font-mono text-[8.5px] tracking-[1.1px] uppercase">
            {counts.all} waiting · {spaces} {spaces === 1 ? 'space' : 'spaces'}
          </p>
        </div>
        <span className="flex-1" />
        <InboxTabs value={filter} onChange={setFilter} counts={counts} variant="desktop" />
        <Button
          variant="quiet"
          size="sm"
          disabled={entries.length === 0}
          onClick={() => unreadService.markAllRead()}
        >
          Mark all read
        </Button>
      </header>
      <div className="flex max-h-[min(640px,75vh)] min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-4 pt-3.5">
        {shown.length === 0 ? (
          <InboxEmpty filter={filter} />
        ) : (
          <>
            {days.map((g) => (
              <section key={g.key} className="flex flex-col gap-1.5">
                <DayHead>{g.label}</DayHead>
                {g.entries.map((e) =>
                  e.kind === 'channel' ? (
                    <ChannelItem key={e.key} entry={e} onNavigate={onNavigate} />
                  ) : (
                    <MentionItem key={e.key} entry={e} onNavigate={onNavigate} />
                  )
                )}
              </section>
            ))}
            <InboxEnd />
          </>
        )}
      </div>
    </div>
  )
}
