import { useEffect, useState } from 'react'
import { Check, Copy, Pencil, Trash2 } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { cn } from '@/lib/utils'

interface MessageToolbarProps {
  onCopy: () => void
  /** Omitted when the message isn't mine. */
  onEdit?: () => void
  /** Omitted when I can't delete it (not mine and no MANAGE_MESSAGES). */
  onDelete?: () => void
  className?: string
}

/**
 * Slack-style hover cluster pinned to the top right of a transcript row. Square, hard shadow.
 * Delete is two-step: the first click arms it, the second deletes.
 */
export function MessageToolbar({
  onCopy,
  onEdit,
  onDelete,
  className
}: MessageToolbarProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
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
        'bg-popover text-popover-foreground flex border p-0.5 shadow-md',
        // Hidden until the row is hovered or something inside it has keyboard focus.
        'pointer-events-none opacity-0 group-hover/row:pointer-events-auto group-hover/row:opacity-100',
        'focus-within:pointer-events-auto focus-within:opacity-100',
        armed && 'pointer-events-auto opacity-100',
        className
      )}
    >
      <IconButton
        size="sm"
        label={copied ? 'Copied' : 'Copy text'}
        onClick={() => {
          onCopy()
          setCopied(true)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </IconButton>
      {onEdit && (
        <IconButton size="sm" label="Edit" onClick={onEdit}>
          <Pencil />
        </IconButton>
      )}
      {onDelete && (
        <>
          <IconButton
            size="sm"
            tone="danger"
            label={armed ? 'Click again to delete' : 'Delete'}
            className={cn(
              armed && 'bg-destructive hover:bg-destructive text-white hover:text-white'
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
            <span aria-hidden className="text-destructive self-center px-1.5 text-xs font-medium">
              Delete?
            </span>
          )}
        </>
      )}
    </div>
  )
}
