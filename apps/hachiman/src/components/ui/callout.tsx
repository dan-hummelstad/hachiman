import { CircleAlert, CircleCheck, Info, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

export type CalloutTone = 'info' | 'caution' | 'danger' | 'success'

const TONE: Record<CalloutTone, { className: string; icon: React.ReactNode }> = {
  info: { className: 'border-accent-primary [&>svg]:text-accent-text', icon: <Info /> },
  caution: {
    className: 'border-feature-event [&>svg]:text-feature-event-text',
    icon: <ShieldAlert />
  },
  danger: {
    className: 'border-feature-danger [&>svg]:text-feature-danger-text',
    icon: <CircleAlert />
  },
  success: {
    className: 'border-feature-voice [&>svg]:text-feature-voice-text',
    icon: <CircleCheck />
  }
}

/**
 * Square notice with a coloured left bar and icon: info (accent), caution (gold), danger (red),
 * success (green). An optional bold title goes above the body.
 */
export function Callout({
  tone = 'info',
  title,
  children,
  className
}: {
  tone?: CalloutTone
  title?: React.ReactNode
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const t = TONE[tone]
  return (
    <div
      role="note"
      data-slot="callout"
      data-tone={tone}
      className={cn(
        'bg-surface-raised flex items-start gap-2.5 border-l-[3px] px-3 py-2.5 text-[13px] leading-[18px] [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0',
        t.className,
        className
      )}
    >
      {t.icon}
      <div className="grid min-w-0 gap-0.5">
        {title && <p className="text-text-primary font-bold">{title}</p>}
        <div className="text-text-secondary">{children}</div>
      </div>
    </div>
  )
}
