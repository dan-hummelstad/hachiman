import { cn } from '@/lib/utils'

/** The `live` dot: a voice room with people in it, mic or recording on, someone typing. */
export function LiveDot({ className }: { className?: string }): React.JSX.Element {
  return <span aria-hidden className={cn('bg-live size-[5px] shrink-0 rounded-full', className)} />
}

/** The `live` pill: a dot and a mono label ("LIVE" by default). */
export function LivePill({
  children = 'LIVE',
  className
}: {
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-slot="live-pill"
      className={cn(
        'rounded-badge bg-live-tint text-live-text inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-[1px] uppercase',
        className
      )}
    >
      <LiveDot />
      {children}
    </span>
  )
}
