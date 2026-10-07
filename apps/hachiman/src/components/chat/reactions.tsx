import { useMemo, useState } from 'react'
import { SmilePlus } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { QUICK_EMOJI, reactionChips } from '@/lib/reactions'
import { cn } from '@/lib/utils'
import { useReactions } from '@/stores/messagesStore'
import { useUserStore } from '@/stores/userStore'
import { react } from './transcript-actions'

const FOCUS = 'focus-visible:outline-line-focus outline-none focus-visible:outline-2'

/**
 * A popover with a grid of common emoji, anchored to `children` (the button that opens it).
 * Controlled: the toolbar keeps itself shown while the picker is open.
 */
export function EmojiPicker({
  open,
  onOpenChange,
  onPick,
  children
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (emoji: string) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <span className="inline-flex">{children}</span>
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="end"
        className="bg-surface-raised border-line-hairline w-auto p-1.5"
        aria-label="Pick a reaction"
      >
        <div className="grid grid-cols-8 gap-0.5">
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={`React with ${emoji}`}
              onClick={() => {
                onPick(emoji)
                onOpenChange(false)
              }}
              className={cn(
                'rounded-control hover:bg-surface-hover flex size-8 items-center justify-center text-[18px] leading-none',
                FOCUS
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

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
          aria-label={`${c.emoji} ${c.count}, ${c.mine ? 'remove your reaction' : 'react'}`}
          onClick={() => react(channelId, target, c.emoji, c.mine)}
          className={cn(
            chip,
            FOCUS,
            c.mine
              ? 'bg-accent-tint border-accent-primary text-accent-text'
              : 'bg-surface-raised text-text-secondary hover:border-line-strong border-transparent'
          )}
        >
          <span className="text-[15px]">{c.emoji}</span>
          {c.count}
        </button>
      ))}
      <EmojiPicker
        open={picking}
        onOpenChange={setPicking}
        onPick={(emoji) => react(channelId, target, emoji, false)}
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
