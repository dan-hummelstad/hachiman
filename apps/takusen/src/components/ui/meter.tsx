import { cn } from '@/lib/utils'

const DOT_TONES = {
  online: 'bg-status-online',
  offline: 'bg-status-offline',
  warning: 'bg-feature-event',
  info: 'bg-feature-thread',
  danger: 'bg-feature-danger',
} as const

/** 7px status dot (sessions, nodes of a region). */
export function Dot({
  tone,
  title,
  className,
}: {
  tone: keyof typeof DOT_TONES
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      title={title}
      className={cn('inline-block size-[7px] shrink-0 rounded-full', DOT_TONES[tone], className)}
    />
  )
}

const METER_TONES = {
  voice: 'bg-feature-voice',
  info: 'bg-feature-thread',
  warning: 'bg-feature-event',
  danger: 'bg-feature-danger',
  gold: 'bg-gold',
} as const

/** Square load bar (F1 voice per region, F4 sessions and CPU). `value / max`, clamped. */
export function Meter({
  value,
  max,
  tone = 'voice',
  label,
  className,
}: {
  value: number
  max: number
  tone?: keyof typeof METER_TONES
  label?: string
  className?: string
}): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('h-2 w-full bg-surface-raised', className)}
    >
      <div className={cn('h-full', METER_TONES[tone])} style={{ width: `${pct}%` }} />
    </div>
  )
}
