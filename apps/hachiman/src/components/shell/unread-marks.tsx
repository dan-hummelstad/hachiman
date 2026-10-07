import type { UnreadBadge } from '@/lib/notify'
import { cn } from '@/lib/utils'

/** "99+" above 99. */
const countLabel = (n: number): string => (n > 99 ? '99+' : String(n))

/** The coral mention count pill of a row (N7): 18 high. Renders nothing at 0. */
export function MentionCount({
  count,
  className
}: {
  count: number
  className?: string
}): React.JSX.Element | null {
  if (count <= 0) return null
  return (
    <span
      aria-label={`${count} mention${count === 1 ? '' : 's'}`}
      className={cn(
        'bg-feature-danger flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] leading-none font-extrabold text-white tabular-nums',
        className
      )}
    >
      {countLabel(count)}
    </span>
  )
}

/**
 * The corner mark of a space-bar button or a DM tile: the coral mention count, else a white dot
 * for unread. Place it in a `relative` box; it sits on the top-right corner.
 */
export function CornerBadge({
  badge,
  dot = true,
  className
}: {
  badge: UnreadBadge
  /** False: show only the mention count, never the unread dot (DM tiles). */
  dot?: boolean
  className?: string
}): React.JSX.Element | null {
  if (badge.mentions > 0) {
    return (
      <span
        aria-label={`${badge.mentions} mention${badge.mentions === 1 ? '' : 's'}`}
        className={cn(
          'bg-feature-danger ring-surface-window pointer-events-none absolute -top-1 -right-1.5 flex h-[15px] min-w-[15px] items-center justify-center rounded-full px-1 text-[9px] leading-none font-extrabold text-white tabular-nums ring-2',
          className
        )}
      >
        {countLabel(badge.mentions)}
      </span>
    )
  }
  if (!dot || !badge.unread) return null
  return (
    <span
      aria-label="Unread"
      className={cn(
        'bg-text-primary ring-surface-window pointer-events-none absolute -top-0.5 -right-0.5 size-[7px] rounded-full ring-2',
        className
      )}
    />
  )
}

/** The 4px white pip at the far-left edge of the sidebar for an unread channel row (B1 #lfg). */
export function UnreadPip({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        'bg-text-primary pointer-events-none absolute top-1/2 h-2 w-1 -translate-y-1/2 rounded-r-full',
        className
      )}
    />
  )
}
