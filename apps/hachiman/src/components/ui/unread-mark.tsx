import { unreadMarkOf } from '@/lib/unread-mark'
import { cn } from '@/lib/utils'

const PILL =
  'bg-feature-danger text-text-on-accent flex shrink-0 items-center justify-center rounded-full leading-none font-extrabold tabular-nums'

const COUNT = {
  md: 'h-[18px] min-w-[18px] px-1.5 text-[11px]',
  sm: 'h-4 min-w-4 px-1 text-[10px]',
  corner:
    'ring-surface-window pointer-events-none absolute -top-1 -right-1.5 h-[15px] min-w-[15px] px-1 text-[9px] ring-2'
}

const DOT = {
  md: 'size-2',
  sm: 'size-1.5',
  corner: 'ring-surface-window pointer-events-none absolute -top-0.5 -right-0.5 size-[7px] ring-2'
}

/**
 * The one unread mark (N7): the coral mention count, else a white dot for unread. `size` 'md' for
 * list rows, 'sm' for tabs and switcher rows, 'corner' on the top-right corner of a `relative`
 * icon box. `dot` false: mentions only. `count` false: mentions as a coral dot, no number.
 */
export function UnreadMark({
  badge,
  size = 'md',
  dot,
  count,
  'aria-hidden': hidden,
  className
}: {
  badge: { mentions: number; unread: boolean }
  size?: 'md' | 'sm' | 'corner'
  dot?: boolean
  count?: boolean
  /** True when the label of the owner already says it. */
  'aria-hidden'?: boolean
  className?: string
}): React.JSX.Element | null {
  const mark = unreadMarkOf(badge, { dot, count })
  if (!mark) return null
  const a11y = hidden
    ? { 'aria-hidden': true }
    : { 'aria-label': mark.kind === 'dot' ? 'Unread' : mark.aria }
  if (mark.kind === 'count') {
    return (
      <span {...a11y} className={cn(PILL, COUNT[size], className)}>
        {mark.label}
      </span>
    )
  }
  return (
    <span
      {...a11y}
      className={cn(
        'shrink-0 rounded-full',
        mark.kind === 'dot' ? 'bg-text-primary' : 'bg-feature-danger',
        DOT[size],
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
