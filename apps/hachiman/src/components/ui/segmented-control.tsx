import { useRef } from 'react'
import { radioStep } from '@/lib/roving'
import { cn } from '@/lib/utils'

export interface SegmentedOption<T extends string> {
  value: T
  /** The text, or with `iconOnly` the accessible name and the tooltip. */
  label: string
  icon?: React.ReactNode
  /** Optional count, shown as a small square chip after the label. */
  count?: number
  /** The look of this option when selected (default: the raised fill). */
  selectedClassName?: string
}

/**
 * Two or three exclusive views in one control (Members | Pages). Radio-group semantics: one tab
 * stop, the arrow keys move and select.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  iconOnly = false,
  className
}: {
  options: readonly SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name of the group. */
  label: string
  /** Show only the icons; the labels name the options. */
  iconOnly?: boolean
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const current = Math.max(
    options.findIndex((o) => o.value === value),
    0
  )
  const onKeyDown = (e: React.KeyboardEvent): void => {
    const next = radioStep(current, options.length, e.key)
    if (next === null) return
    e.preventDefault()
    if (options[next].value !== value) onChange(options[next].value)
    ref.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={label}
      data-slot="segmented-control"
      onKeyDown={onKeyDown}
      className={cn('rounded-control bg-surface-sunken inline-flex gap-0.5 p-0.5', className)}
    >
      {options.map((o, i) => {
        const selected = i === current
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={iconOnly ? o.label : undefined}
            title={iconOnly ? o.label : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => o.value !== value && onChange(o.value)}
            className={cn(
              "rounded-control inline-flex h-7 flex-1 items-center justify-center gap-1.5 text-[13px] font-semibold transition-colors outline-none focus-visible:outline-2 focus-visible:outline-line-focus [&_svg:not([class*='size-'])]:size-4",
              iconOnly ? 'w-9 px-0' : 'px-3',
              selected
                ? (o.selectedClassName ?? 'bg-surface-raised text-text-primary')
                : 'text-text-tertiary hover:text-text-primary'
            )}
          >
            {o.icon}
            {!iconOnly && o.label}
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
