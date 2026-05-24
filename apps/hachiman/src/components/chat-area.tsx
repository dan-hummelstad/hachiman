import { useCallback, useEffect, useRef, useState } from 'react'
import { Hash, Users, Volume2 } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { MessageToolbar } from '@/components/message-toolbar'
import { messagesService } from '@/services/MessagesService'
import { useMessageStore, type Message } from '@/stores/messagesStore'
import type { ChannelType } from '@/stores/channelStore'

interface ChatAreaProps {
  channelId: number | null
  channelName: string | null
  channelType: ChannelType | null
  membersOpen: boolean
  onToggleMembers: () => void
  onSendMessage: (text: string) => void
}

const PAGE_SIZE = 25

// Stable empty-array reference so the zustand selector returns a cached
// snapshot when the channel has no messages yet, avoiding the
// "getSnapshot should be cached" render loop.
const EMPTY_MESSAGES: Message[] = []

export function ChatArea(props: ChatAreaProps): React.JSX.Element {
  const { channelId, channelName, channelType, membersOpen, onToggleMembers, onSendMessage } = props

  const messages = useMessageStore((s) =>
    channelId !== null ? (s.history.get(channelId) ?? EMPTY_MESSAGES) : EMPTY_MESSAGES
  )

  // Tag the async hasMore result with the channel it came from. On channel
  // switch the tag stops matching, so `hasMore` derives back to false without
  // a synchronous reset inside the effect.
  const [pagination, setPagination] = useState<{
    channelId: number
    hasMore: boolean
  } | null>(null)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Voice channels are non-persistent: skip the history fetch and pagination
  // wiring entirely so we don't burn a round-trip on a guaranteed-empty page.
  const isPersistent = channelType === 'text'
  const hasMore =
    isPersistent && pagination !== null && pagination.channelId === channelId
      ? pagination.hasMore
      : false

  // Load the latest history page when the selected channel changes. Voice
  // channels skip this — their chat is live-only (no persisted history).
  useEffect(() => {
    if (channelId === null || !isPersistent) return
    let cancelled = false
    void messagesService.loadHistory(channelId, { limit: PAGE_SIZE }).then((res) => {
      if (cancelled) return
      setPagination({ channelId, hasMore: res.hasMore })
    })
    return () => {
      cancelled = true
    }
  }, [channelId, isPersistent])

  // Older-message pagination: when scrolled near the top, fetch the next
  // older page using the oldest currently-loaded historic message's id.
  // Historic ids are numeric strings; live messages use UUIDs (non-numeric)
  // and are skipped over when picking the cursor.
  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (channelId === null || !isPersistent) return
      if (!hasMore || isLoadingMore) return
      const el = e.currentTarget
      if (el.scrollTop > 80) return

      let beforeId: bigint | undefined
      for (const m of messages) {
        if (/^\d+$/.test(m.id)) {
          beforeId = BigInt(m.id)
          break
        }
      }

      setIsLoadingMore(true)
      void messagesService
        .loadHistory(
          channelId,
          beforeId !== undefined ? { beforeId, limit: PAGE_SIZE } : { limit: PAGE_SIZE }
        )
        .then((res) => setPagination({ channelId, hasMore: res.hasMore }))
        .finally(() => setIsLoadingMore(false))
    },
    [channelId, hasMore, isLoadingMore, messages, isPersistent]
  )

  if (channelId === null) {
    return (
      <section className="flex h-screen flex-1 flex-col items-center justify-center">
        <Hash className="text-muted-foreground mb-3 h-10 w-10" />
        <p className="text-muted-foreground text-sm">Select a channel to start chatting.</p>
      </section>
    )
  }

  return (
    <section className="flex h-screen flex-1 flex-col overflow-hidden">
      <header className="bg-background flex h-12 shrink-0 items-center gap-2 border-b px-4">
        {channelType === 'voice' ? (
          <Volume2 className="text-muted-foreground h-4 w-4" />
        ) : (
          <Hash className="text-muted-foreground h-4 w-4" />
        )}
        <h1 className="text-sm font-semibold">{channelName ?? '—'}</h1>
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <span className="text-muted-foreground text-xs">
          {channelType === 'voice'
            ? 'Voice channel — chat here is not saved.'
            : 'Viewing — send messages without joining voice.'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            aria-pressed={membersOpen}
            aria-label="Toggle members"
            onClick={onToggleMembers}
            className="h-8 w-8"
            title="Toggle members"
          >
            <Users className="h-4 w-4" />
          </Button>
        </div>
      </header>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto"
        data-slot="chat-scroll"
      >
        <div className="flex min-h-full flex-col-reverse justify-start">
          <div className="flex flex-col">
            <div className="border-b px-4 py-6">
              <h2 className="mb-1 text-xl font-semibold">Welcome to #{channelName ?? 'channel'}</h2>
              <p className="text-muted-foreground text-sm">
                This is the beginning of your conversation in this channel.
              </p>
            </div>
            {isLoadingMore && (
              <div className="text-muted-foreground py-2 text-center text-xs">
                Loading older messages…
              </div>
            )}
            <div className="flex flex-col">
              {messages.map((message) => (
                <MessageItem key={message.id} message={message} />
              ))}
            </div>
          </div>
        </div>
      </div>
      <footer className="bg-background shrink-0 border-t">
        <MessageToolbar onSendMessage={onSendMessage} />
      </footer>
    </section>
  )
}

function MessageItem({ message }: { message: Message }): React.JSX.Element {
  return (
    <div className="group hover:bg-muted/50 flex gap-3 px-4 py-2">
      <Avatar className="mt-0.5 h-10 w-10">
        <AvatarImage src={message.avatar} alt={message.author} />
        <AvatarFallback>{message.author[0]?.toUpperCase() ?? '?'}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{message.author}</span>
          <span className="text-muted-foreground text-xs">{message.date.toLocaleTimeString()}</span>
        </div>
        <p className="text-foreground/90 wrap-break-word text-sm">{message.content}</p>
      </div>
    </div>
  )
}
