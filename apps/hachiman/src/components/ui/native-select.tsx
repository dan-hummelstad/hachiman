import { ChevronsUpDown } from 'lucide-react'
import {
  FieldLead,
  LEAD_PADDING,
  TOUCH_FIELD,
  useFieldControl,
  type FieldSize
} from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * Native <select> in the input look, with the chevrons-up-down mark (no Radix Select installed).
 * Takes every <select> prop. `className` styles the wrapper, so width classes apply to the field.
 * `size="touch"` is the mobile kit field (48 tall, text 16); `lead` is an icon at the start.
 */
export function NativeSelect({
  className,
  size = 'default',
  lead,
  ...props
}: Omit<React.ComponentProps<'select'>, 'size'> & {
  size?: FieldSize
  lead?: React.ReactNode
}): React.JSX.Element {
  const touch = size === 'touch'
  const field = useFieldControl()
  return (
    <span data-slot="native-select-wrapper" className={cn('relative inline-flex', className)}>
      {lead != null && <FieldLead size={size}>{lead}</FieldLead>}
      <select
        {...field}
        data-slot="native-select"
        className={cn(
          'rounded-control border-line-strong bg-surface-sunken text-text-primary hover:border-text-disabled focus-visible:border-accent-primary aria-invalid:border-destructive h-9 w-full appearance-none border pr-8 pl-3 text-sm outline-none disabled:opacity-50',
          touch && [TOUCH_FIELD, 'h-12 pr-10'],
          lead != null && LEAD_PADDING[size]
        )}
        {...props}
      />
      <ChevronsUpDown
        aria-hidden
        className={cn(
          'text-text-tertiary pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2',
          touch && 'right-3.5 size-[17px]'
        )}
      />
    </span>
  )
}
