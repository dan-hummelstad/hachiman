import { useEffect, useMemo, useState } from 'react'
import type { Channel } from '@hachiman/client'
import { CheckCheck } from 'lucide-react'
import { create } from 'zustand'
import { closeDrawer, countLocalPushed } from '@/components/mobile/drawer-state'
import { PushedScreen } from '@/components/mobile/pushed-screen'
import { cn } from '@/lib/utils'
import { unreadService } from '@/services/UnreadService'
import { usePlatform } from '@/shared/PlatformContext'
import { useChannelStore } from '@/stores/channelStore'
import { useDocsStore } from '@/stores/docsStore'
import { useGuildStore } from '@/stores/guildStore'
import { useMessageStore } from '@/stores/messagesStore'
import { currentView, sameView, useNavStore } from '@/stores/navStore'
import { useNotifyPrefs } from '@/stores/prefsStore'
import { useUnreadStore } from '@/stores/unreadStore'
import {
  filterInbox,
  inboxCounts,
  inboxEntries,
  mentionEntries,
  unreadGroups,
  type InboxEntry,
  type InboxFilter
} from './inbox-model'
import { ChannelItem, InboxEmpty, InboxEnd, InboxTabs, MentionItem } from './inbox-rows'

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
 * in the Nav Bar, the tabs All, Mentions, Unreads and Threads, then one
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

/** The inbox entries (mentions and unread channels), newest first. Hooks: mount only while shown. */
// eslint-disable-next-line react-refresh/only-export-components
export function useInboxEntries(): InboxEntry[] {
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

/** How many guilds the entries come from. */
// eslint-disable-next-line react-refresh/only-export-components
export function spacesOf(
  entries: readonly InboxEntry[],
  channels: ReadonlyMap<string, Channel>
): number {
  const ids = new Set<string>()
  for (const e of entries) {
    const id = channels.get(e.kind === 'mention' ? e.channelId : e.channel.id)?.guildId
    if (id) ids.add(id)
  }
  return ids.size
}

function InboxScreenBody({ open }: { open: boolean }): React.JSX.Element {
  const platform = usePlatform()
  const [filter, setFilter] = useState<InboxFilter>('all')
  const entries = useInboxEntries()
  const channels = useChannelStore((s) => s.channels)
  const counts = useMemo(() => inboxCounts(entries), [entries])
  const shown = useMemo(() => filterInbox(entries, filter), [entries, filter])
  const spaces = useMemo(() => spacesOf(shown, channels), [shown, channels])

  const markAll = (): void => {
    if (unreadService.markAllRead() > 0) platform.haptic('success')
  }

  return (
    <PushedScreen
      open={open}
      title="Inbox"
      subtitle={
        counts.all > 0
          ? `${counts.all} WAITING · ${spaces} ${spaces === 1 ? 'SPACE' : 'SPACES'}`
          : 'ALL CAUGHT UP'
      }
      onBack={closeInboxScreen}
      action={<MarkAllReadButton disabled={entries.length === 0} onClick={markAll} />}
      bodyClassName="p-0"
    >
      <div className="shrink-0 px-3.5 py-2.5">
        <InboxTabs value={filter} onChange={setFilter} counts={counts} variant="mobile" />
      </div>
      {shown.length === 0 ? (
        <InboxEmpty filter={filter} />
      ) : (
        <>
          <ul className="flex flex-col">
            {shown.map((e) => (
              <li key={e.key}>
                {e.kind === 'channel' ? (
                  <ChannelItem entry={e} onNavigate={closeInboxScreen} />
                ) : (
                  <MentionItem entry={e} onNavigate={closeInboxScreen} />
                )}
              </li>
            ))}
          </ul>
          <InboxEnd />
        </>
      )}
    </PushedScreen>
  )
}

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
        'border-line-strong text-text-secondary active:bg-surface-hover inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill border px-3 text-[13px] font-semibold whitespace-nowrap transition-colors',
        'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
        'disabled:pointer-events-none disabled:opacity-50'
      )}
    >
      <CheckCheck aria-hidden className="size-4" />
      Mark all read
    </button>
  )
}
