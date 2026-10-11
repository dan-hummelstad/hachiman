import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { MessageActionSheet } from '@/components/mobile/message-action-sheet'
import { useChatCovered } from '@/components/mobile/drawer-state'
import { useContactTrust } from '@/components/people/use-contact-trust'
import { useDmStageShown } from '@/components/voice/dm-stage-state'
import { SystemTag } from '@/components/ui/system-tag'
import { useLayout } from '@/hooks/use-layout'
import { highlightRow, jumpStep } from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { messagesService } from '@/services/MessagesService'
import { unreadService } from '@/services/UnreadService'
import { useCryptoStore } from '@/stores/cryptoStore'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { useNavStore } from '@/stores/navStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { useFirstUnreadId } from '@/stores/unreadStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useMembershipTimeline } from '@/hooks/use-membership-timeline'
import { ChannelIntro } from './channel-intro'
import { buildItems, formatDay, joinSlots, keyChangeSlot, membershipSlots } from './format'
import { KeyChangeLine } from './key-change-line'
import { JoinLine, MembershipLine } from './membership-line'
import { TranscriptRow } from './message-row'
import type { RowPolicy } from './row-policy'

const EMPTY_MESSAGES: ChatMessage[] = []
/** Distance from the bottom (px) past which "Jump to present" appears. */
const AWAY_PX = 400
/** Distance from the top (px) at which older history starts loading. */
const LOAD_PX = 200

/** The row that a long press lifted (mobile): a new `seq` per press gives a fresh sheet. */
interface Lift {
  /** The message at the press; the live row replaces it while it is still in the store. */
  message: ChatMessage
  row: HTMLElement
  seq: number
}

/**
 * The log. A `flex-col-reverse` scroller keeps us pinned to the bottom for free and keeps the
 * view steady when older pages are prepended above. Mount it keyed by channel id: per-channel
 * view state (scroll) starts fresh. The chat body owns the editing row, so that Arrow Up in the
 * composer can start an edit.
 */
export function Transcript({
  channel,
  policy,
  onUpload,
  editingId,
  onEditingChange
}: {
  channel: Channel
  /** What I may do with the rows, the same object for every row. */
  policy: RowPolicy
  /** ATTACH_FILES: the drop card of an empty channel offers an upload. */
  onUpload?: (files: File[]) => void
  editingId: string | null
  onEditingChange: (messageId: string | null) => void
}): React.JSX.Element {
  const channelId = channel.id
  const messages = useMessageStore((s) => s.byChannel.get(channelId) ?? EMPTY_MESSAGES)
  const hasMore = useMessageStore((s) => s.hasMore.get(channelId))
  const mobile = useLayout() === 'mobile'
  // The density cards of M31 (spec E2) set it on the phone too.
  const display = usePrefsStore((s) => s.messageDisplay)
  const myId = useUserStore((s) => s.me?.id)

  const scroller = useRef<HTMLDivElement>(null)
  const [away, setAway] = useState(false)

  const items = useMemo(() => buildItems(messages), [messages])
  const firstUnreadId = useFirstUnreadId(channelId)
  const bottom = useMarkRead(channelId, messages, myId)
  const membership = useMembershipTimeline(channelId)
  // "A added B" is routine (each new member and device): the welcome channel greets new members.
  const slots = useMemo(
    () =>
      membershipSlots(
        messages,
        membership.filter((e) => e.kind !== 'added')
      ),
    [messages, membership]
  )
  const guildId = channel.guildId
  const members = useGuildStore((s) =>
    guildId && s.guilds.get(guildId)?.welcomeChannelId === channelId
      ? s.members.get(guildId)
      : undefined
  )
  const joins = useMemo(
    () => (members ? joinSlots(messages, members.values(), hasMore === false) : undefined),
    [messages, members, hasMore]
  )
  const keyNotice = useKeyChangeNotice(channel, mobile)
  const keySlot = keyNotice ? keyChangeSlot(messages, keyNotice.changedAt, hasMore === false) : null
  /**
   * The membership, join and key change lines before message `i` (`items.length`: after the
   * last one).
   */
  const notesAt = (i: number): React.ReactNode => (
    <>
      {slots.get(i)?.map((e, j) => (
        <MembershipLine key={`m${j}`} event={e} channel={channel} />
      ))}
      {joins?.get(i)?.map((m) => (
        <JoinLine key={`j${m.user.id}`} member={m} channel={channel} />
      ))}
      {keyNotice && keySlot === i && <KeyChangeLine userId={keyNotice.userId} />}
    </>
  )

  useEffect(() => {
    messagesService.ensureLoaded(channelId)
  }, [channelId])

  // The message action sheet of the mobile layout (spec A3): one per transcript.
  const [lift, setLift] = useState<Lift | null>(null)
  const [liftOpen, setLiftOpen] = useState(false)
  const openActions = useCallback(
    (messageId: string, row: HTMLElement): void => {
      const message = useMessageStore
        .getState()
        .byChannel.get(channelId)
        ?.find((m) => m.id === messageId)
      if (!message) return
      setLift((prev) => ({ message, row, seq: (prev?.seq ?? 0) + 1 }))
      setLiftOpen(true)
    },
    [channelId]
  )
  // The live row, so pins and reactions show as they change. A deleted row keeps its last state
  // until its sheet and confirm have closed.
  const liftMessage = lift && (messages.find((m) => m.id === lift.message.id) ?? lift.message)

  // A jump from pins, the inbox or a thread start (lib/navigation): show the row once it renders.
  const jumpId = useNavStore((s) =>
    s.pendingJump?.channelId === channelId ? s.pendingJump.messageId : null
  )
  useEffect(() => {
    if (jumpId === null) return
    const step = jumpStep(
      jumpId,
      messages.map((m) => m.id),
      hasMore !== undefined
    )
    if (step === 'wait') return
    if (step === 'show') highlightRow(jumpId)
    useNavStore.getState().setPendingJump(null)
  }, [jumpId, messages, hasMore])

  const jumpToPresent = useCallback((smooth = true): void => {
    scroller.current?.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  // My own send always brings me back to the present.
  const last = messages[messages.length - 1]
  const lastIsMyPending = !!last?.pending && last.author.id === myId
  useEffect(() => {
    if (lastIsMyPending) jumpToPresent(false)
  }, [lastIsMyPending, last?.id, jumpToPresent])

  // Older history loads near the top, and keeps loading while a short page doesn't fill the view.
  // MessagesService dedupes overlapping requests and stops once history is exhausted.
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    // Column-reverse: scrollTop is 0 at the bottom and goes negative upwards.
    const el = e.currentTarget
    setAway(-el.scrollTop > AWAY_PX)
    if (hasMore && el.scrollHeight - el.clientHeight + el.scrollTop < LOAD_PX) {
      void messagesService.loadOlder(channelId)
    }
  }
  useEffect(() => {
    const el = scroller.current
    if (el && hasMore && el.scrollHeight <= el.clientHeight)
      void messagesService.loadOlder(channelId)
  }, [channelId, hasMore, items.length])

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={onScroll}
        // Mobile: the focus can land here when the row it was on is deleted (the action sheet).
        tabIndex={mobile ? -1 : undefined}
        className="mobile:touch-pan-y mobile:outline-none flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"
        data-slot="chat-scroll"
      >
        <div className="flex flex-col pt-4 pb-3">
          {hasMore === false ? (
            <ChannelIntro channel={channel} empty={messages.length === 0} onUpload={onUpload} />
          ) : (
            <div className="text-text-tertiary text-meta px-5 py-3">
              {hasMore === undefined ? 'Loading messages…' : 'Loading older messages…'}
            </div>
          )}
          {items.map(({ message, newDay, groupStart }, i) => (
            <Fragment key={message.nonce ?? message.id}>
              {newDay && <DayDivider iso={message.createdAt} />}
              {notesAt(i)}
              {message.id === firstUnreadId && <NewDivider />}
              <TranscriptRow
                message={message}
                groupStart={groupStart || message.id === firstUnreadId}
                display={display}
                guildId={channel.guildId}
                policy={policy}
                editing={editingId === message.id}
                onEditingChange={onEditingChange}
                onActions={mobile ? openActions : undefined}
              />
            </Fragment>
          ))}
          {notesAt(items.length)}
          <div ref={bottom} aria-hidden className="h-px" />
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={() => jumpToPresent()}
          className={cn(
            'rounded-pill bg-surface-raised border-line-hairline text-text-primary hover:bg-surface-panel absolute right-5 bottom-3 flex h-8 items-center gap-2 border px-3 text-xs font-semibold shadow-lg shadow-black/20',
            // A 36 touch target. The footer (typing line, voice bar, composer) sits below.
            'mobile:right-4 mobile:h-9 mobile:px-3.5',
            'focus-visible:outline-line-focus outline-none focus-visible:outline-2'
          )}
        >
          <ArrowDown className="size-3.5" />
          Jump to present
        </button>
      )}
      {mobile && lift && liftMessage && (
        <MessageActionSheet
          key={lift.seq}
          message={liftMessage}
          row={lift.row}
          guildId={channel.guildId}
          policy={policy}
          onEditingChange={onEditingChange}
          open={liftOpen}
          onOpenChange={setLiftOpen}
        />
      )}
    </div>
  )
}

/**
 * M59 on the mobile layout: the other person of a 1:1 DM has a key change of 'notice' severity
 * (never verified). Their trust gives the time of the change (`changedAt`). Null while the trust
 * loads, once the change is no longer pending, and on the desktop layout (its corner notice).
 */
function useKeyChangeNotice(
  channel: Channel,
  mobile: boolean
): { userId: string; changedAt: string | null } | null {
  const peerId = channel.type === 'dm' ? channel.recipients?.[0]?.id : undefined
  const notice = useCryptoStore(
    (s) =>
      mobile &&
      peerId !== undefined &&
      s.keyChanges.some((k) => k.userId === peerId && k.severity === 'notice')
  )
  const { trust, error } = useContactTrust(notice ? peerId : undefined)
  if (!notice || peerId === undefined) return null
  // The Worker cannot answer: show the line after the last message rather than not at all.
  if (error !== null) return { userId: peerId, changedAt: null }
  if (trust?.userId !== peerId || trust.state !== 'changed') return null
  return { userId: peerId, changedAt: trust.changedAt }
}

const seen = (): boolean => document.hasFocus() && document.visibilityState === 'visible'

/**
 * Read acks (N7). The channel counts as read up to its newest sent message while the bottom of
 * the transcript is in view, the window has focus and shows, and nothing covers the chat (a mobile
 * drawer, pushed screen or DM call stage), and right after my own message arrives. Returns the
 * ref of a sentinel under the last row.
 */
function useMarkRead(
  channelId: string,
  messages: readonly ChatMessage[],
  myId: string | undefined
): React.RefCallback<HTMLDivElement> {
  const [inView, setInView] = useState(false)
  const [focused, setFocused] = useState(seen)
  // The stage of a mobile DM call hides the chat as well (MobileChatPane).
  const stage = useDmStageShown(channelId)
  const covered = useChatCovered() || stage

  const bottom = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), {
      root: el.closest('[data-slot="chat-scroll"]')
    })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  useEffect(() => {
    const on = (): void => setFocused(seen())
    window.addEventListener('focus', on)
    window.addEventListener('blur', on)
    // An app in the background (iOS) can keep the focus but not show.
    document.addEventListener('visibilitychange', on)
    return () => {
      window.removeEventListener('focus', on)
      window.removeEventListener('blur', on)
      document.removeEventListener('visibilitychange', on)
    }
  }, [])

  // The newest row that the server has (pending and failed rows have no server id yet).
  let last: ChatMessage | undefined
  for (let i = messages.length - 1; i >= 0 && !last; i--) {
    if (!messages[i].pending && !messages[i].failed) last = messages[i]
  }
  const lastId = last?.id
  const lastIsMine = last !== undefined && last.author.id === myId
  useEffect(() => {
    if (lastId && ((inView && focused && !covered) || lastIsMine))
      unreadService.markRead(channelId, lastId)
  }, [channelId, lastId, lastIsMine, inView, focused, covered])

  return bottom
}

/** The NEW divider: a coral hairline with the tag on the right, above the first unread row. */
function NewDivider(): React.JSX.Element {
  return (
    <div
      role="separator"
      aria-label="New messages"
      className="mt-3 mb-1 flex items-center gap-2 pr-4 pl-5"
    >
      {/* A 2px coral wash (B1/B2): a 1px full-strength line reads as a grey rule at 1x. */}
      <div className="bg-feature-danger/25 h-0.5 flex-1" />
      <SystemTag kind="new" />
    </div>
  )
}

/** The date centered on a hairline. */
function DayDivider({ iso }: { iso: string }): React.JSX.Element {
  return (
    <div role="separator" className="mt-5 mb-2 flex items-center gap-3 px-5 first:mt-0">
      <div className="bg-line-hairline h-px flex-1" />
      <span className="text-text-tertiary text-meta font-semibold tabular-nums">
        {formatDay(iso)}
      </span>
      <div className="bg-line-hairline h-px flex-1" />
    </div>
  )
}
