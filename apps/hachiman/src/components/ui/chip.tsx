import { cn } from '@/lib/utils'

export type ChipTone = 'accent' | 'voice' | 'event' | 'danger' | 'neutral'

const TONE: Record<ChipTone, string> = {
  accent: 'bg-here-tint text-here-text',
  voice: 'bg-live-tint text-live-text',
  event: 'border border-line-strong text-text-tertiary',
  danger: 'bg-you-tint text-you-text',
  neutral: 'border border-line-strong text-text-tertiary'
}

/** The smaller desktop chip (the device list tags): the neutral tag look. */
const SM_TONE: Record<ChipTone, string> = TONE

/**
 * Status chip (M24, M25, M28): 20 tall, label 11/600, neutral unless it answers a question, an optional 11 icon before it.
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
        'rounded-badge inline-flex h-5 shrink-0 items-center gap-1 px-1.5 text-[11px] leading-none font-semibold whitespace-nowrap [&_svg]:size-[11px] [&_svg]:shrink-0',
        size === 'sm'
          ? ['h-[18px] font-mono text-[8.5px] font-medium tracking-[0.8px] uppercase [&_svg]:size-3', SM_TONE[tone]]
          : TONE[tone],
        className
      )}
    >
      {icon}
      {children}
    </span>
  )
}
