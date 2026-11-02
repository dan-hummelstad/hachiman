import { cn } from '@/lib/utils'

/**
 * The selectable-row look: radius 4, the hover fill, and the neutral selected fill with primary
 * text (the mark of the current row is `here`, drawn by the caller). The caller adds the layout (height, padding, gap).
 */
export function selectableRowClass(selected: boolean, className?: string): string {
  return cn(
    'rounded-row',
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
