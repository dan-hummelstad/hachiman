import { cn } from '@/lib/utils'

/**
 * The Arc selectable-row look (docs/ui-redesign.md §5): radius 8, the hover fill, and the
 * selected fill with primary text. The caller adds the layout (height, padding, gap).
 */
export function selectableRowClass(selected: boolean, className?: string): string {
  return cn(
    'rounded-control',
    selected
      ? 'bg-surface-selected text-text-primary'
      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
    className
  )
}

/** A selectable 32px list row button. */
export function SelectableRow({
  selected,
  className,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & { selected: boolean }): React.JSX.Element {
  return (
    <button
      type={type}
      aria-current={selected ? 'true' : undefined}
      className={selectableRowClass(
        selected,
        cn('flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-sm', className)
      )}
      {...props}
    />
  )
}
