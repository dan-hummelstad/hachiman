import { ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Native <select> in the input look, with the chevrons-up-down mark (no Radix Select installed).
 * Takes every <select> prop. `className` styles the wrapper, so width classes apply to the field.
 */
export function NativeSelect({
  className,
  ...props
}: React.ComponentProps<'select'>): React.JSX.Element {
  return (
    <span data-slot="native-select-wrapper" className={cn('relative inline-flex', className)}>
      <select
        data-slot="native-select"
        className="rounded-control border-line-strong bg-surface-sunken text-text-primary hover:border-text-disabled focus-visible:border-accent-primary h-9 w-full appearance-none border pr-8 pl-3 text-sm outline-none disabled:opacity-50"
        {...props}
      />
      <ChevronsUpDown
        aria-hidden
        className="text-text-tertiary pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2"
      />
    </span>
  )
}
