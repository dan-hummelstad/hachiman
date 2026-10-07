import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Native checkbox in the Arc look (radius 4). Takes every <input> prop except `type`. */
export function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type'>): React.JSX.Element {
  return (
    <span className={cn('relative inline-flex size-4 shrink-0', className)}>
      <input
        type="checkbox"
        data-slot="checkbox"
        className="peer rounded-check border-line-strong bg-surface-sunken checked:border-accent-primary checked:bg-accent-primary hover:border-text-disabled focus-visible:outline-line-focus size-4 appearance-none border transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <Check
        aria-hidden
        strokeWidth={3}
        className="text-text-on-accent pointer-events-none absolute inset-0.5 hidden size-3 peer-checked:block"
      />
    </span>
  )
}
