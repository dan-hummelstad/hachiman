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
 * The reaction chips under a message (N10): emoji and count, `here` ring when I reacted; a click
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
  // The chips keep their 22 look; on the mobile layout each takes a 36 hit height, and the gaps
  // grow so that the hit areas of two chips do not meet (spec §2.10).
  const chip = cn(
    'rounded-pill mobile:h-7 mobile:px-2.5 mobile:gap-1.5 flex h-[22px] items-center gap-[5px] border px-[7px] font-mono text-[9.5px] leading-none tracking-[0.8px] tabular-nums transition-colors',
    'mobile:relative mobile:after:absolute mobile:after:-inset-x-0.5 mobile:after:-inset-y-1'
  )
  return (
    <div
      className="mobile:gap-x-1.5 mobile:gap-y-2 mobile:pt-1.5 flex flex-wrap items-center gap-1.5 pt-1"
      role="group"
      aria-label="Reactions"
    >
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
              ? 'bg-here-tint border-here text-here-text'
              : 'text-text-tertiary border-line-strong hover:bg-surface-hover bg-transparent'
          )}
        >
          <ReactionEmoji value={c.emoji} className="mobile:text-[15px] text-[11px]" />
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
            'text-text-disabled hover:text-text-primary border-line-hairline mobile:w-9 w-6 justify-center bg-transparent px-0'
          )}
        >
          <SmilePlus className="mobile:size-4 size-3" />
        </button>
      </EmojiPicker>
    </div>
  )
}
