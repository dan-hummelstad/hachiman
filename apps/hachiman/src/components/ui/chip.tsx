import { cn } from '@/lib/utils'

/**
 * A pill filter or reaction chip. With `selected` it takes the accent outline and tint.
 * Renders a <button>; children are an optional 13 px icon and the label or count.
 */
export function Chip({
  selected,
  className,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & { selected?: boolean }): React.JSX.Element {
  return (
    <button
      type={type}
      data-slot="chip"
      aria-pressed={selected}
      className={cn(
        "rounded-pill inline-flex h-7 shrink-0 items-center gap-1.5 border px-3 text-[13px] leading-none font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-line-focus disabled:opacity-50 [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0",
        selected
          ? 'border-accent-primary bg-accent-tint text-accent-text'
          : 'bg-surface-raised text-text-secondary hover:text-text-primary border-transparent',
        className
      )}
      {...props}
    />
  )
}
