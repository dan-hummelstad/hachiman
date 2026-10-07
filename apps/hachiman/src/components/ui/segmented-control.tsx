import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  label: string
  icon?: React.ReactNode
  /** Optional count, shown as a small square chip after the label. */
  count?: number
}

/** Two or three exclusive views in one control (Members | Pages). Radio-group semantics. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name of the group. */
  label: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot="segmented-control"
      className={cn('rounded-control bg-surface-sunken inline-flex gap-0.5 p-0.5', className)}
    >
      {options.map((o) => {
        const selected = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-control inline-flex h-7 flex-1 items-center justify-center gap-1.5 px-3 text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-line-focus [&_svg:not([class*='size-'])]:size-4",
              selected
                ? 'bg-surface-raised text-text-primary'
                : 'text-text-tertiary hover:text-text-primary'
            )}
          >
            {o.icon}
            {o.label}
            {o.count !== undefined && (
              <span className="bg-surface-raised text-text-secondary px-1 text-[10.5px] leading-4 font-bold tabular-nums">
                {o.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
