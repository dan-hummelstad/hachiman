import { useMemo } from 'react'
import { SmilePlus } from 'lucide-react'
import { ReactionEmoji } from '@/components/chat/emoji'
import { quickReactionKeys, usableReactionKey } from '@/components/chat/message-actions'
import { reactionLabel } from '@/lib/custom-emoji'
import { cn } from '@/lib/utils'
import { useGuildStore } from '@/stores/guildStore'
import { useReactions } from '@/stores/messagesStore'
import { usePrefsStore } from '@/stores/prefsStore'
import { useUserStore } from '@/stores/userStore'

/** One 46 tile: they share the row (M5), radius 10. */
const TILE = cn(
  'rounded-option flex h-[46px] min-w-0 flex-1 items-center justify-center border outline-none',
  'focus-visible:outline-line-focus focus-visible:outline-2 active:brightness-125'
)

/**
 * The quick reactions on top of the message action sheet (M5): six emojis from my recent picks,
 * topped up with defaults, then "More reactions" for the picker. My reactions on the message are
 * lit. A tap calls `onReact` with the key and whether it is mine (a tap takes it back).
 */
export function QuickReactions({
  channelId,
  target,
  onReact,
  onMore
}: {
  channelId: string
  /** The client_msg_id of the message. */
  target: string
  onReact: (key: string, mine: boolean) => void
  onMore: () => void
}): React.JSX.Element {
  const recent = usePrefsStore((s) => s.recentEmojis)
  const index = useGuildStore((s) => s.emojiIndex)
  const reactions = useReactions(channelId, target)
  const myId = useUserStore((s) => s.me?.id)
  const keys = useMemo(
    () => quickReactionKeys(recent, (key) => usableReactionKey(key, index)),
    [recent, index]
  )

  return (
    <div role="group" aria-label="Quick reactions" className="mb-3 flex shrink-0 gap-2">
      {keys.map((key) => {
        const mine = myId !== undefined && (reactions.get(key)?.has(myId) ?? false)
        return (
          <button
            key={key}
            type="button"
            aria-pressed={mine}
            aria-label={`${reactionLabel(key)}, ${mine ? 'remove your reaction' : 'react'}`}
            onClick={() => onReact(key, mine)}
            className={cn(
              TILE,
              mine
                ? 'bg-accent-primary/16 border-accent-primary/60'
                : 'border-transparent bg-(--fill-control)'
            )}
          >
            <ReactionEmoji value={key} className="text-[22px] leading-none" />
          </button>
        )
      })}
      <button
        type="button"
        aria-label="More reactions"
        onClick={onMore}
        className={cn(TILE, 'text-text-tertiary border-transparent bg-(--fill-control)')}
      >
        <SmilePlus className="size-[22px]" aria-hidden />
      </button>
    </div>
  )
}
