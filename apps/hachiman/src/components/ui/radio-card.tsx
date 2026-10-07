import { cn } from '@/lib/utils'
import { FEATURE_BORDER, FEATURE_TILE, type Feature } from '@/components/ui/feature'

/**
 * One option of a radio group as a card (radius 10): icon tile, title, description and the
 * radio mark. The selected card takes the border of its feature colour. The input is a native
 * radio, so a group of cards with one `name` is keyboard-navigable.
 */
export function RadioCard({
  icon,
  title,
  description,
  feature = 'accent',
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'title'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  feature?: Feature
}): React.JSX.Element {
  return (
    <label
      data-slot="radio-card"
      className={cn(
        'rounded-option border-line-hairline hover:bg-surface-hover has-checked:bg-surface-hover has-focus-visible:outline-line-focus flex cursor-pointer items-center gap-3 border px-3 py-2.5 transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-1',
        props.checked && FEATURE_BORDER[feature],
        className
      )}
    >
      <input type="radio" className="peer sr-only" {...props} />
      {icon && (
        <span
          aria-hidden
          className={cn(
            'rounded-control flex size-9 shrink-0 items-center justify-center [&_svg]:size-4',
            FEATURE_TILE[feature]
          )}
        >
          {icon}
        </span>
      )}
      <span className="grid min-w-0 flex-1">
        <span className="text-label text-text-primary">{title}</span>
        {description && <span className="text-meta text-text-secondary">{description}</span>}
      </span>
      <span
        aria-hidden
        className="rounded-pill border-line-strong peer-checked:border-accent-primary peer-checked:bg-accent-primary flex size-5 shrink-0 items-center justify-center border-2 transition-colors after:size-2 after:rounded-full after:bg-white after:opacity-0 peer-checked:after:opacity-100"
      />
    </label>
  )
}
