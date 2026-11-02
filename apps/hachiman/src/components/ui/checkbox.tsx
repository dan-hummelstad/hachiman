import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Native checkbox (radius 4, ink when checked). Takes every <input> prop except `type`.
 * `size="lg"` is the mobile kit box (18); put it in a 44 label row, so the row is the hit area.
 */
export function Checkbox({
  className,
  size = 'default',
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'size'> & {
  size?: 'default' | 'lg'
}): React.JSX.Element {
  const lg = size === 'lg'
  return (
    <span className={cn('relative inline-flex size-4 shrink-0', lg && 'size-[18px]', className)}>
      <input
        type="checkbox"
        data-slot="checkbox"
        className={cn(
          'peer rounded-check border-line-strong bg-surface-sunken checked:border-ink checked:bg-ink hover:border-text-disabled focus-visible:outline-line-focus size-4 appearance-none border transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
          lg && 'size-[18px]'
        )}
        {...props}
      />
      <Check
        aria-hidden
        strokeWidth={3}
        className={cn(
          'text-on-ink pointer-events-none absolute inset-0.5 hidden size-3 peer-checked:block',
          lg && 'inset-[2.5px] size-[13px]'
        )}
      />
    </span>
  )
}
