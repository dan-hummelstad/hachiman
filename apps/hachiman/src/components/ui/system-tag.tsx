import { BadgeCheck, Lock, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export type SystemTagKind = 'page' | 'live' | 'bot' | 'new' | 'you' | 'encrypted' | 'key-changed'

const TAG: Record<SystemTagKind, { label: string; className: string; icon?: React.ReactNode }> = {
  page: { label: 'PAGE', className: 'bg-feature-page/15 text-feature-page-text' },
  live: { label: 'LIVE', className: 'bg-feature-danger text-text-on-accent' },
  bot: {
    label: 'BOT',
    className: 'bg-accent-primary text-text-on-accent',
    icon: <BadgeCheck aria-hidden />
  },
  new: { label: 'NEW', className: 'bg-feature-danger text-text-on-accent' },
  you: { label: 'YOU', className: 'bg-surface-raised text-text-secondary' },
  encrypted: {
    label: 'ENCRYPTED',
    className: 'bg-feature-voice/15 text-feature-voice-text',
    icon: <Lock aria-hidden />
  },
  'key-changed': {
    label: 'KEY CHANGED',
    className: 'bg-feature-event/15 text-feature-event-text',
    icon: <ShieldAlert aria-hidden />
  }
}

/** Square uppercase system tag: PAGE, LIVE, BOT, NEW, YOU, ENCRYPTED, KEY CHANGED. */
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
        'inline-flex h-[18px] shrink-0 items-center gap-1 px-1.5 text-[10px] leading-none font-extrabold tracking-[0.6px] [&_svg]:size-3',
        tag.className,
        className
      )}
    >
      {tag.icon}
      {tag.label}
    </span>
  )
}
