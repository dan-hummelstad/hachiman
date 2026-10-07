import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown } from 'lucide-react'
import type { Channel } from '@hachiman/client'
import { channelLabel } from '@/lib/model'
import { messagesService } from '@/services/MessagesService'
import { useMessageStore, type ChatMessage } from '@/stores/messagesStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'
import { useMembershipTimeline } from '@/hooks/use-membership-timeline'
import { buildItems, formatDay, membershipSlots } from './format'
import { MembershipLine } from './membership-line'
import { MessageRow } from './message-row'

const EMPTY_MESSAGES: ChatMessage[] = []
/** Distance from the bottom (px) past which "Jump to present" appears. */
const AWAY_PX = 400
/** Distance from the top (px) at which older history starts loading. */
const LOAD_PX = 200

/**
 * The log. A `flex-col-reverse` scroller keeps us pinned to the bottom for free and keeps the
 * view steady when older pages are prepended above. Mount it keyed by channel id: per-channel
 * view state (scroll, editing) starts fresh.
 */
export function Transcript({
  channel,
  canManageMessages
}: {
  channel: Channel
  /** May delete others' messages. */
  canManageMessages: boolean
}): React.JSX.Element {
  const channelId = channel.id
  const messages = useMessageStore((s) => s.byChannel.get(channelId) ?? EMPTY_MESSAGES)
  const hasMore = useMessageStore((s) => s.hasMore.get(channelId))
  const display = usePrefsStore((s) => s.messageDisplay)
  const myId = useUserStore((s) => s.me?.id)

  const scroller = useRef<HTMLDivElement>(null)
  const [away, setAway] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const items = useMemo(() => buildItems(messages), [messages])
  const membership = useMembershipTimeline(channelId)
  const slots = useMemo(() => membershipSlots(messages, membership), [messages, membership])

  useEffect(() => {
    messagesService.ensureLoaded(channelId)
  }, [channelId])

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
        className="flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"
        data-slot="chat-scroll"
      >
        <div className="flex flex-col pt-4 pb-3">
          {hasMore === false ? (
            <ChannelIntro channel={channel} />
          ) : (
            <div className="text-muted-foreground px-4 py-3 text-xs">
              {hasMore === undefined ? 'Loading messages…' : 'Loading older messages…'}
            </div>
          )}
          {items.map(({ message, newDay, groupStart }, i) => {
            const mine = message.author.id === myId
            return (
              <Fragment key={message.nonce ?? message.id}>
                {newDay && <DayDivider iso={message.createdAt} />}
                {slots.get(i)?.map((e, j) => (
                  <MembershipLine key={`m${j}`} event={e} channel={channel} />
                ))}
                <MessageRow
                  message={message}
                  groupStart={groupStart}
                  display={display}
                  guildId={channel.guildId}
                  canEdit={mine}
                  canDelete={mine || canManageMessages}
                  editing={editingId === message.id}
                  onEditingChange={setEditingId}
                />
              </Fragment>
            )
          })}
          {slots.get(items.length)?.map((e, j) => (
            <MembershipLine key={`m${j}`} event={e} channel={channel} />
          ))}
        </div>
      </div>
      {away && (
        <button
          type="button"
          onClick={() => jumpToPresent()}
          className="bg-popover text-popover-foreground hover:bg-accent focus-visible:outline-ring absolute right-4 bottom-3 flex h-8 items-center gap-2 border px-3 text-xs font-medium shadow-md focus-visible:outline-2"
        >
          <ArrowDown className="size-3.5" />
          Jump to present
        </button>
      )}
    </div>
  )
}

function DayDivider({ iso }: { iso: string }): React.JSX.Element {
  return (
    <div role="separator" className="mt-5 mb-1 flex items-center gap-3 px-4 first:mt-0">
      <div className="bg-border h-px flex-1" />
      <span className="text-muted-foreground text-xs tabular-nums">{formatDay(iso)}</span>
      <div className="bg-border h-px flex-1" />
    </div>
  )
}

function ChannelIntro({ channel }: { channel: Channel }): React.JSX.Element {
  const { name, sigil } = channelLabel(channel)
  return (
    <div className="px-4 pt-8 pb-4">
      <div className="bg-card text-muted-foreground mb-4 flex size-12 items-center justify-center border font-mono text-2xl">
        {sigil}
      </div>
      <h2 className="text-xl leading-7 font-semibold">
        {sigil === '@' ? (
          <>
            This is the start of your conversation with{' '}
            <span className="font-semibold">{name}</span>.
          </>
        ) : (
          <>
            This is the start of <span className="font-semibold">#{name}</span>.
          </>
        )}
      </h2>
      {channel.topic && (
        <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">{channel.topic}</p>
      )}
    </div>
  )
}
