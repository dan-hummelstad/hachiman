import { cn } from '@/lib/utils'
import { FEATURE_BORDER, FEATURE_TILE, type Feature } from '@/components/ui/feature'

/** The checked mobile card: the tint of its feature colour (full literals for Tailwind). */
const CHECKED_TINT: Record<Feature, string> = {
  accent: 'has-checked:bg-here-tint',
  voice: 'has-checked:bg-live-tint',
  event: 'has-checked:bg-here-tint',
  page: 'has-checked:bg-here-tint',
  thread: 'has-checked:bg-here-tint',
  danger: 'has-checked:bg-you-tint',
  bot: 'has-checked:bg-here-tint'
}

/**
 * One option of a radio group as a card (radius 10): an optional preview on top, then the icon
 * tile, title, description and the radio mark. The selected card takes the border of its feature
 * colour. The input is a native radio, so a group of cards with one `name` is keyboard-navigable.
 *
 * `size="mobile"` is the mobile kit card (M16, M31, M47): padding 14, tile 40, title 15.5/800,
 * radio 22 and a feature tint on the checked card. `mark="foot"` puts the radio before the title
 * in the foot row under a preview (M31). `badge` is a small pill above the title.
 */
export function RadioCard({
  icon,
  title,
  description,
  preview,
  badge,
  feature = 'accent',
  size = 'default',
  mark = 'end',
  className,
  ...props
}: Omit<React.ComponentProps<'input'>, 'type' | 'title' | 'size'> & {
  icon?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  /** A picture of the option above the title row (Appearance). */
  preview?: React.ReactNode
  /** A short pill above the title, for example "Recommended". */
  badge?: React.ReactNode
  feature?: Feature
  size?: 'default' | 'mobile'
  /** Where the radio mark sits: at the end of the title row, or first in the foot row. */
  mark?: 'end' | 'foot'
}): React.JSX.Element {
  const mobile = size === 'mobile'
  const foot = mark === 'foot'
  const radio = (
    <RadioMark
      checked={props.checked === true}
      size={mobile ? (foot ? 'foot' : 'mobile') : 'default'}
    />
  )
  return (
    <label
      data-slot="radio-card"
      className={cn(
        mobile
          ? 'rounded-option border-line-hairline has-focus-visible:outline-line-focus flex cursor-pointer border-[1.5px] bg-surface-raised transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-1'
          : 'rounded-option border-line-hairline hover:bg-surface-hover has-checked:bg-surface-hover has-focus-visible:outline-line-focus flex cursor-pointer border transition-colors has-focus-visible:outline-2 has-focus-visible:outline-offset-1',
        mobile && CHECKED_TINT[feature],
        preview
          ? mobile
            ? 'flex-col gap-2.5 p-2'
            : 'flex-col gap-3 p-2.5'
          : mobile
            ? 'items-center gap-3 p-3.5'
            : 'items-center gap-3 px-3 py-2.5',
        props.checked && FEATURE_BORDER[feature],
        className
      )}
    >
      <input type="radio" className="sr-only" {...props} />
      {preview}
      <span
        className={cn(
          'flex items-center gap-3',
          preview && 'px-1',
          mobile && !preview && 'min-w-0 flex-1',
          mobile && foot && preview && 'gap-2 px-0.5'
        )}
      >
        {foot && radio}
        {icon && (
          <span
            aria-hidden
            className={cn(
              'flex size-9 shrink-0 items-center justify-center [&_svg]:size-4',
              mobile && 'size-10 [&_svg]:size-5',
              FEATURE_TILE[feature]
            )}
          >
            {icon}
          </span>
        )}
        <span
          className={cn(
            'grid min-w-0 flex-1',
            mobile ? (foot ? 'gap-px' : 'gap-1') : badge && 'gap-1'
          )}
        >
          {badge && (
            <span
              className={cn(
                'rounded-pill inline-flex h-5 items-center justify-self-start px-2 text-[10.5px] font-semibold tracking-[0.6px] uppercase',
                FEATURE_TILE[feature]
              )}
            >
              {badge}
            </span>
          )}
          <span
            className={
              !mobile
                ? 'text-label text-text-primary'
                : foot
                  ? 'text-text-primary text-sm leading-[1.2] font-semibold'
                  : 'text-text-primary text-[15.5px] leading-5 font-semibold'
            }
          >
            {title}
          </span>
          {description && (
            <span
              className={
                !mobile
                  ? 'text-meta text-text-secondary'
                  : foot
                    ? 'text-text-tertiary text-xs leading-4'
                    : 'text-text-secondary text-[13px] leading-[1.4]'
              }
            >
              {description}
            </span>
          )}
        </span>
        {!foot && radio}
      </span>
    </label>
  )
}

/** The radio mark: filled on desktop; on mobile a ring with a dot (22) or a thick ring (18, foot). */
function RadioMark({
  checked,
  size
}: {
  checked: boolean
  size: 'default' | 'mobile' | 'foot'
}): React.JSX.Element {
  if (size === 'default') {
    return (
      <span
        aria-hidden
        className={cn(
          'rounded-pill flex size-5 shrink-0 items-center justify-center border-2 transition-colors',
          checked ? 'border-here bg-here' : 'border-line-strong'
        )}
      >
        {checked && <span className="bg-on-here size-2 rounded-full" />}
      </span>
    )
  }
  return (
    <span
      aria-hidden
      className={cn(
        'rounded-pill flex shrink-0 items-center justify-center transition-colors',
        size === 'foot' ? 'size-[18px]' : 'size-[22px]',
        !checked
          ? 'border-text-disabled border-[1.5px]'
          : size === 'foot'
            ? 'border-here border-[5.5px]'
            : 'border-here border-2'
      )}
    >
      {checked && size === 'mobile' && <span className="bg-here size-2.5 rounded-full" />}
    </span>
  )
}
