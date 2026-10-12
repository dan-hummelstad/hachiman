import {
  ArrowUpRight,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Info,
  ShieldAlert
} from 'lucide-react'
import { cn } from '@/lib/utils'

export type CalloutTone = 'info' | 'caution' | 'danger' | 'success'

/** An action row under the body: a link (opens in a new window) or a button. */
export type CalloutAction = { label: string } & (
  { href: string; onClick?: never } | { onClick: () => void; href?: never }
)

const TONE: Record<
  CalloutTone,
  { box: string; svg: string; action: string; icon: React.ReactNode }
> = {
  info: {
    box: 'border-accent-primary/40 bg-accent-tint',
    svg: '[&>svg]:text-accent-text',
    action: 'border-accent-primary/40 text-accent-text',
    icon: <Info />
  },
  caution: {
    box: 'border-feature-event/40 bg-feature-event/10',
    svg: '[&>svg]:text-feature-event-text',
    action: 'border-feature-event/40 text-feature-event-text',
    icon: <ShieldAlert />
  },
  danger: {
    box: 'border-feature-danger/40 bg-feature-danger/10',
    svg: '[&>svg]:text-feature-danger-text',
    action: 'border-feature-danger/40 text-feature-danger-text',
    icon: <CircleAlert />
  },
  success: {
    box: 'border-feature-voice/40 bg-feature-voice/10',
    svg: '[&>svg]:text-feature-voice-text',
    action: 'border-feature-voice/40 text-feature-voice-text',
    icon: <CircleCheck />
  }
}

/**
 * Square notice with a tinted fill, a coloured border and icon: info (accent), caution (gold), danger (red),
 * success (green). An optional bold title goes above the body. `icon` replaces the tone's icon.
 * `action` adds a row under the body. `size="touch"` is the mobile kit callout: title 14/800,
 * body 13.5/500, padding 12/14, action row 44.
 */
export function Callout({
  tone = 'info',
  title,
  icon,
  action,
  size = 'default',
  children,
  className
}: {
  tone?: CalloutTone
  title?: React.ReactNode
  icon?: React.ReactNode
  action?: CalloutAction
  size?: 'default' | 'touch'
  children?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const t = TONE[tone]
  const touch = size === 'touch'
  const row = cn(
    'flex items-start gap-2.5 px-3 py-2.5 text-[13px] leading-[18px] [&>svg]:mt-px [&>svg]:size-4 [&>svg]:shrink-0',
    touch && 'gap-3 px-3.5 py-3 text-[13.5px] leading-[1.45] [&>svg]:size-[18px]'
  )
  const body = (
    <>
      {icon ?? t.icon}
      <div className={cn('grid min-w-0 gap-0.5', touch && 'gap-[3px]')}>
        {title && (
          <p className={cn('text-text-primary font-bold', touch && 'text-sm font-extrabold')}>
            {title}
          </p>
        )}
        <div className={cn('text-text-secondary', touch && 'font-medium')}>{children}</div>
      </div>
    </>
  )
  if (!action) {
    return (
      <div
        role="note"
        data-slot="callout"
        data-tone={tone}
        className={cn(row, 'border', t.box, t.svg, className)}
      >
        {body}
      </div>
    )
  }
  const actionClass = cn(
    'hover:bg-surface-hover mobile:active:bg-surface-hover focus-visible:outline-line-focus flex h-9 w-full items-center gap-2 border-t pr-3 pl-[38px] text-left text-[13px] font-bold outline-none focus-visible:outline-2 focus-visible:-outline-offset-2',
    touch && 'h-11 pr-3.5 pl-11 text-sm font-extrabold',
    t.action
  )
  const mark = touch ? 'ml-auto size-[17px] shrink-0' : 'ml-auto size-4 shrink-0'
  return (
    <div
      role="note"
      data-slot="callout"
      data-tone={tone}
      className={cn('grid border', t.box, className)}
    >
      <div className={cn(row, t.svg)}>{body}</div>
      {action.href !== undefined ? (
        <a href={action.href} target="_blank" rel="noreferrer noopener" className={actionClass}>
          {action.label}
          <ArrowUpRight aria-hidden className={mark} />
        </a>
      ) : (
        <button type="button" onClick={action.onClick} className={actionClass}>
          {action.label}
          <ChevronRight aria-hidden className={mark} />
        </button>
      )}
    </div>
  )
}
