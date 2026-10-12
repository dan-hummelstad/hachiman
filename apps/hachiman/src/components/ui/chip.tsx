import { cn } from '@/lib/utils'

export type ChipTone = 'accent' | 'voice' | 'event' | 'danger' | 'neutral'

const TONE: Record<ChipTone, string> = {
  accent: 'bg-accent-primary/20 text-accent-text',
  voice: 'bg-feature-voice/12 text-feature-voice-text',
  event: 'bg-feature-event/12 text-feature-event-text',
  danger: 'bg-feature-danger/12 text-feature-danger-text',
  neutral: 'bg-surface-raised text-text-secondary'
}

/** The smaller desktop chip (the device list tags): its tone fills are a touch stronger. */
const SM_TONE: Record<ChipTone, string> = {
  ...TONE,
  accent: 'bg-accent-tint text-accent-text',
  voice: 'bg-feature-voice/15 text-feature-voice-text',
  event: 'bg-feature-event/15 text-feature-event-text'
}

/**
 * Square status chip (M24, M25, M28): 20 tall, label 11/800, an optional 11 icon before it.
 * For example "This device" (accent) or "Has security key" (voice).
 * `size="sm"` is 18 tall, label 10.5/700, icon 12 (the desktop device list).
 */
export function Chip({
  tone = 'neutral',
  size = 'default',
  icon,
  children,
  className
}: {
  tone?: ChipTone
  size?: 'default' | 'sm'
  /** A decorative icon before the label. */
  icon?: React.ReactNode
  children: React.ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <span
      data-slot="chip"
      data-tone={tone}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 px-1.5 text-[11px] leading-none font-extrabold whitespace-nowrap [&_svg]:size-[11px] [&_svg]:shrink-0',
        size === 'sm'
          ? ['h-[18px] text-[10.5px] font-bold [&_svg]:size-3', SM_TONE[tone]]
          : TONE[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
}
