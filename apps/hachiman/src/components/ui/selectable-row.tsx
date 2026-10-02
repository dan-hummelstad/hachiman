import { cn } from '@/lib/utils'

interface RowLook {
  /** Show the 4px amber notch on the left when selected (default true). */
  notch?: boolean
}

/**
 * Classes for a 32px list row with the selected look (accent fill, plus the notch by default).
 * For rows that aren't a single button (e.g. a <li> holding a button plus row actions).
 */
export function selectableRowClass(
  selected: boolean,
  className?: string,
  { notch = true }: RowLook = {}
): string {
  return cn(
    'relative flex h-8 w-full items-center gap-1.5 px-2.5 text-left text-sm',
    selected
      ? 'bg-accent text-foreground font-medium'
      : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
    selected &&
      notch &&
      'before:bg-primary before:absolute before:inset-y-0 before:left-0 before:w-1',
    className
  )
}

/** A selectable list row button (settings nav, roles list, overwrites list, sidebar rows). */
export function SelectableRow({
  selected,
  notch,
  className,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & { selected: boolean } & RowLook): React.JSX.Element {
  return (
    <button
      type={type}
      aria-current={selected ? 'true' : undefined}
      className={selectableRowClass(selected, className, { notch })}
      {...props}
    />
  )
}
