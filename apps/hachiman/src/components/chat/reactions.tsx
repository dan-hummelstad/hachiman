import { useMemo, useState } from 'react'
import { SmilePlus } from 'lucide-react'
import { reactionChips } from '@/lib/reactions'
import { cn } from '@/lib/utils'
import { useChannelStore } from '@/stores/channelStore'
import { useReactions } from '@/stores/messagesStore'
import { useUserStore } from '@/stores/userStore'
import { reactionKeyOf, reactionLabel } from '@/lib/custom-emoji'
import { ReactionEmoji } from './emoji'
import { EmojiPicker } from './emoji-picker'
import { react } from './transcript-actions'

const FOCUS = 'focus-visible:outline-line-focus outline-none focus-visible:outline-2'

/**
 * The reaction chips under a message (N10): emoji and count, accent ring when I reacted; a click
 * toggles my reaction. The last chip adds a reaction. Nothing renders without reactions: the hover
 * toolbar has the React button for the first one.
 */
export function ReactionChips({
  channelId,
  target
}: {
  channelId: string
  /** The client_msg_id of the message. */
  target: string
}): React.JSX.Element | null {
  const reactions = useReactions(channelId, target)
  const myId = useUserStore((s) => s.me?.id)
  const chips = useMemo(() => reactionChips(reactions, myId), [reactions, myId])
  const [picking, setPicking] = useState(false)
  const guildId = useChannelStore((s) => s.channels.get(channelId)?.guildId ?? null)
  if (chips.length === 0) return null
  const chip =
    'rounded-pill flex h-7 items-center gap-1.5 border px-2 text-[13px] leading-none font-semibold tabular-nums transition-colors'
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1" role="group" aria-label="Reactions">
      {chips.map((c) => (
        <button
          key={c.emoji}
          type="button"
          aria-pressed={c.mine}
          aria-label={`${reactionLabel(c.emoji)} ${c.count}, ${c.mine ? 'remove your reaction' : 'react'}`}
          onClick={() => react(channelId, target, c.emoji, c.mine)}
          className={cn(
            chip,
            FOCUS,
            c.mine
              ? 'bg-accent-tint border-accent-primary text-accent-text'
              : 'bg-surface-raised text-text-secondary hover:border-line-strong border-transparent'
          )}
        >
          <ReactionEmoji value={c.emoji} className="text-[15px]" />
          {c.count}
        </button>
      ))}
      <EmojiPicker
        open={picking}
        onOpenChange={setPicking}
        guildId={guildId}
        label="Pick a reaction"
        onPick={(pick) => react(channelId, target, reactionKeyOf(pick), false)}
      >
        <button
          type="button"
          aria-label="Add reaction"
          title="Add reaction"
          onClick={() => setPicking((v) => !v)}
          className={cn(
            chip,
            FOCUS,
            'bg-surface-raised text-text-tertiary hover:text-text-primary border-transparent'
          )}
        >
          <SmilePlus className="size-4" />
        </button>
      </EmojiPicker>
    </div>
  )
}
