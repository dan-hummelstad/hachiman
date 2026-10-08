import { useEffect, useState } from 'react'
import { useCopy } from '@/hooks/use-copy'
import { Check, Copy, Ellipsis, Pencil, Reply, SmilePlus, Trash2 } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'
import { EmojiPicker, reactionKeyOf } from './emoji-picker'

/** Rounded 28px icon buttons with 16px icons. */
const BUTTON = 'text-text-secondary hover:bg-surface-hover hover:text-text-primary size-7'

interface MessageToolbarProps {
  /** Adds a reaction (N10): a Unicode emoji or a custom `name:id`. Omitted when I can't react (not sent yet, no SEND_MESSAGES). */
  onReact?: (emoji: string) => void
  /** The guild of the message: its custom emojis come first in the picker. */
  guildId?: string | null
  /** Makes this message the reply target of the composer (N11). */
  onReply?: () => void
  /** The text that "Copy text" copies. Omitted when the message did not decrypt. */
  copyText?: string
  /** Omitted when the message isn't mine. */
  onEdit?: () => void
  /** Omitted when I can't delete it (not mine and no MANAGE_MESSAGES). */
  onDelete?: () => void
  /** The items of the "More" menu (pin N13, thread N12); omitted or null: no "More" button. */
  more?: React.ReactNode
  className?: string
}

/**
 * Hover cluster pinned to the top right of a transcript row: a raised square card with rounded
 * icon buttons. Delete is two-step: the first click arms it, the second deletes. React (N10) and
 * reply (N11) come first; thread (N12) goes after them when it lands.
 */
export function MessageToolbar({
  onReact,
  guildId = null,
  onReply,
  copyText,
  onEdit,
  onDelete,
  more,
  className
}: MessageToolbarProps): React.JSX.Element {
  const { copied, copy } = useCopy({ resetMs: 1200 })
  const [armed, setArmed] = useState(false)
  const [picking, setPicking] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)

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
      {onReact && (
        <EmojiPicker
          open={picking}
          onOpenChange={setPicking}
          guildId={guildId}
          label="Pick a reaction"
          onPick={(pick) => onReact(reactionKeyOf(pick))}
        >
          <IconButton className={BUTTON} label="Add reaction" onClick={() => setPicking((v) => !v)}>
            <SmilePlus />
          </IconButton>
        </EmojiPicker>
      )}
      {onReply && (
        <IconButton className={BUTTON} label="Reply" onClick={onReply}>
          <Reply />
        </IconButton>
      )}
      {copyText !== undefined && (
        <IconButton
          className={BUTTON}
          label={copied !== null ? 'Copied' : 'Copy text'}
          onClick={() => copy(copyText)}
        >
          {copied !== null ? <Check /> : <Copy />}
        </IconButton>
      )}
      {onEdit && (
        <IconButton className={BUTTON} label="Edit" onClick={onEdit}>
          <Pencil />
        </IconButton>
      )}
      {onDelete && (
        <>
          <IconButton
            tone="danger"
            label={armed ? 'Click again to delete' : 'Delete'}
            className={cn(
              BUTTON,
              armed &&
                'bg-feature-danger hover:bg-feature-danger text-text-on-accent hover:text-text-on-accent'
            )}
            onClick={() => {
              if (!armed) return setArmed(true)
              setArmed(false)
              onDelete()
            }}
          >
            <Trash2 />
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
      {more && (
        <DropdownMenu open={moreOpen} onOpenChange={setMoreOpen}>
          <DropdownMenuTrigger asChild>
            <IconButton className={BUTTON} label="More" pressed={moreOpen}>
              <Ellipsis />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {more}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
