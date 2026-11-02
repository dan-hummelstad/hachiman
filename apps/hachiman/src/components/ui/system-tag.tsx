import { BadgeCheck, Lock } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SystemTagKind = 'live' | 'bot' | 'new' | 'you' | 'encrypted'

const NEUTRAL = 'border border-line-strong text-text-tertiary'

const TAG: Record<SystemTagKind, { label: string; className: string; icon?: React.ReactNode }> = {
  live: { label: 'LIVE', className: 'bg-live-tint text-live-text' },
  bot: { label: 'BOT', className: NEUTRAL, icon: <BadgeCheck aria-hidden /> },
  new: { label: 'NEW', className: 'bg-you text-on-you' },
  you: { label: 'YOU', className: NEUTRAL },
  encrypted: { label: 'ENCRYPTED', className: NEUTRAL, icon: <Lock aria-hidden /> }
}

/** Uppercase system tag (neutral, except LIVE and NEW): LIVE, BOT, NEW, YOU, ENCRYPTED. */
export function SystemTag({
  kind,
  className
}: {
  kind: SystemTagKind
  className?: string
}): React.JSX.Element {
  const tag = TAG[kind]
  return (
    <span
      data-slot="system-tag"
      data-kind={kind}
      className={cn(
        'rounded-badge inline-flex h-[18px] shrink-0 items-center gap-1 px-1 font-mono text-[8.5px] leading-none font-medium tracking-[0.8px] [&_svg]:size-3',
        tag.className,
        className
      )}
    >
      {tag.icon}
      {tag.label}
    </span>
  )
}
