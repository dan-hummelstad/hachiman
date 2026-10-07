import { cn } from '@/lib/utils'
import { FEATURE_BORDER, FEATURE_TILE, type Feature } from '@/components/ui/feature'

/**
 * One option of a radio group as a card (radius 10): an optional preview on top, then the icon
 * tile, title, description and the radio mark. The selected card takes the border of its feature
 * colour. The input is a native radio, so a group of cards with one `name` is keyboard-navigable.
 */
export function RadioCard({
  icon,
  title,
  description,
  preview,
  feature = 'accent',
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'title'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** A picture of the option above the title row (Appearance). */
  preview?: React.ReactNode
  feature?: Feature
}): React.JSX.Element {
  return (
    <label
      data-slot="radio-card"
      className={cn(
        'rounded-option border-line-hairline hover:bg-surface-hover has-checked:bg-surface-hover has-focus-visible:outline-line-focus flex cursor-pointer border transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-1',
        preview ? 'flex-col gap-3 p-2.5' : 'items-center gap-3 px-3 py-2.5',
        props.checked && FEATURE_BORDER[feature],
        className
      )}
    >
      <input type="radio" className="sr-only" {...props} />
      {preview}
      <span className={cn('flex items-center gap-3', preview && 'px-1')}>
        {icon && (
          <span
            aria-hidden
            className={cn(
              'flex size-9 shrink-0 items-center justify-center [&_svg]:size-4',
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
          className={cn(
            'rounded-pill flex size-5 shrink-0 items-center justify-center border-2 transition-colors',
            props.checked ? 'border-accent-primary bg-accent-primary' : 'border-line-strong'
          )}
        >
          {props.checked && <span className="size-2 rounded-full bg-white" />}
        </span>
      </span>
    </label>
  )
}
