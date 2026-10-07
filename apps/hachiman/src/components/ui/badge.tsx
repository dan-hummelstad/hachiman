import { cn } from '@/lib/utils'

/** Pill count badge (unread, mentions). Coral by default, `tone="quiet"` for a neutral count. */
export function Badge({
  count,
  tone = 'danger',
  className
}: {
  count: number
  tone?: 'danger' | 'accent' | 'quiet'
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-slot="badge"
      className={cn(
        'rounded-pill inline-flex h-4 min-w-4 shrink-0 items-center justify-center px-1 text-[10.5px] leading-none font-extrabold tabular-nums',
        tone === 'danger' && 'bg-feature-danger text-text-on-accent',
        tone === 'accent' && 'bg-accent-primary text-text-on-accent',
        tone === 'quiet' && 'bg-surface-raised text-text-secondary',
        className
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
