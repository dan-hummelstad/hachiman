import { useEffect, useState } from 'react'
import { Ellipsis } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { reactionKeyOf } from '@/lib/custom-emoji'
import { EmojiPicker } from './emoji-picker'
import { findAction, hasMoreItems, type MessageAction } from './message-actions'
import { MessageMoreItems } from './message-more-items'

/** Rounded 28px icon buttons with 16px icons. */
const BUTTON = 'text-text-secondary hover:bg-surface-hover hover:text-text-primary size-7'

interface MessageToolbarProps {
  /**
   * The row's actions (`useMessageActions`). React (N10), reply (N11), edit and delete show as
   * buttons; pin (N13), thread (N12) and info go into "More".
   */
  actions: readonly MessageAction[]
  /** The guild of the message: its custom emojis come first in the picker. */
  guildId?: string | null
  className?: string
}

/**
 * Hover cluster pinned to the top right of a transcript row: a raised square card with rounded
 * icon buttons. Delete is two-step: the first click arms it, the second deletes. The mobile layout
 * has no toolbar: a long press opens the action sheet with the same actions.
 */
export function MessageToolbar({
  actions,
  guildId = null,
  className
}: MessageToolbarProps): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const [picking, setPicking] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const react = findAction(actions, 'react')
  const reply = findAction(actions, 'reply')
  const edit = findAction(actions, 'edit')
  const del = findAction(actions, 'delete')

  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 3000)
    return () => clearTimeout(t)
  }, [armed])

  return (
    <div
      role="toolbar"
      aria-label="Message actions"
      className={cn(
        'bg-surface-raised border-line-hairline flex gap-0.5 border p-1 shadow-lg shadow-black/20',
        // Hidden until the row is hovered or something inside it has keyboard focus.
        'pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100',
        'focus-within:pointer-events-auto focus-within:opacity-100',
        (armed || picking || moreOpen) && 'pointer-events-auto opacity-100',
        className
      )}
    >
      {react && (
        <EmojiPicker
          open={picking}
          onOpenChange={setPicking}
          guildId={guildId}
          label="Pick a reaction"
          onPick={(pick) => react.run(reactionKeyOf(pick))}
        >
          <IconButton className={BUTTON} label={react.label} onClick={() => setPicking((v) => !v)}>
            <react.icon />
          </IconButton>
        </EmojiPicker>
      )}
      {reply && (
        <IconButton className={BUTTON} label={reply.label} onClick={() => void reply.run()}>
          <reply.icon />
        </IconButton>
      )}
      {edit && (
        <IconButton className={BUTTON} label={edit.label} onClick={() => void edit.run()}>
          <edit.icon />
        </IconButton>
      )}
      {del && (
        <>
          <IconButton
            tone="danger"
            label={armed ? 'Click again to delete' : del.label}
            className={cn(
              BUTTON,
              armed &&
                'bg-feature-danger hover:bg-feature-danger text-text-on-accent hover:text-text-on-accent'
            )}
            onClick={() => {
              if (!armed) return setArmed(true)
              setArmed(false)
              Promise.resolve(del.run()).catch((e: unknown) =>
                console.error('[chat] delete failed', e)
              )
            }}
          >
            <del.icon />
          </IconButton>
          {armed && (
            <span
              aria-hidden
              className="text-feature-danger-text self-center px-1.5 text-xs font-semibold"
            >
              Delete?
            </span>
          )}
        </>
      )}
      {hasMoreItems(actions) && (
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger asChild>
            <IconButton className={BUTTON} label="More" pressed={moreOpen}>
              <Ellipsis />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <MessageMoreItems actions={actions} />
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
