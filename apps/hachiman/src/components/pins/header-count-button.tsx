import { FEATURE_TILE, type Feature } from '@/components/ui/feature'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/**
 * A channel header button with a count (B1: threads "3", pins "4"). With a count it takes the
 * tint of its feature; without one it is a plain icon button. Pass it as a Popover trigger child.
 */
export function HeaderCountButton({
  label,
  count,
  feature,
  pressed,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<'button'>, 'aria-label'> & {
  label: string
  count: number
  feature: Feature
  pressed?: boolean
}): React.JSX.Element {
  const lit = count > 0
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={lit ? `${label} (${count})` : label}
          aria-pressed={pressed}
          className={cn(
            'rounded-control inline-flex h-8 shrink-0 items-center justify-center gap-1.5 text-[13px] leading-none font-bold tabular-nums transition-colors [&_svg]:size-[18px]',
            'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:outline-offset-1',
            lit
              ? cn(FEATURE_TILE[feature], 'px-2.5 hover:brightness-110')
              : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground w-8',
            pressed && !lit && 'bg-accent-tint text-accent-text',
            pressed && lit && 'ring-line-focus ring-1',
            className
          )}
          {...props}
        >
          {children}
          {lit && <span>{count}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/** The frame of a header popover: a title row and a scrolling body. */
export function HeaderPopoverFrame({
  icon,
  title,
  actions,
  children
}: {
  icon: React.ReactNode
  title: string
  actions?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex max-h-[min(560px,70vh)] flex-col">
      <header className="border-line-hairline flex h-11 shrink-0 items-center gap-2 border-b px-3">
        <span className="flex [&_svg]:size-4">{icon}</span>
        <h2 className="text-text-primary flex-1 truncate text-[14px] font-bold">{title}</h2>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{children}</div>
    </div>
  )
}

/** The text of an empty popover list. */
export function EmptyLine({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-text-tertiary px-3 py-6 text-center text-[13px]">{children}</p>
}
