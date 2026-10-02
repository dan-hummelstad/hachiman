import { cn } from '@/lib/utils'

/** Native <select> in the input look (no Radix Select installed). Takes every <select> prop. */
export function NativeSelect({
  className,
  ...props
}: React.ComponentProps<'select'>): React.JSX.Element {
  return (
    <select
      data-slot="native-select"
      className={cn(
        'border-input bg-card text-foreground h-9 border px-2 text-sm outline-none disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}
