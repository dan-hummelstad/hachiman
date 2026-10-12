import { useRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { radioStep } from '@/lib/roving'
import { cn } from '@/lib/utils'

/**
 * One filter chip (M66, M67): 36 high, padding 0/12 (0/10 with a lead icon), 13.5/700, an optional
 * count 12.5/800 and a chevron for a chip that opens a menu. `active` gives the selected look.
 * Semantics come from the caller (`FilterChips` sets them), so a menu trigger can wrap it with
 * `asChild`.
 */
export function FilterChip({
  active = false,
  icon,
  count,
  menu = false,
  className,
  children,
  type = 'button',
  ...props
}: React.ComponentProps<'button'> & {
  active?: boolean
  /** Lead icon (15). */
  icon?: React.ReactNode
  count?: number
  /** A chevron at the end: the chip opens a menu ("From", "In: any guild"). */
  menu?: boolean
}): React.JSX.Element {
  return (
    <button
      type={type}
      data-slot="filter-chip"
      data-active={active || undefined}
      className={cn(
        "rounded-control inline-flex h-9 shrink-0 items-center gap-1.5 border text-[13.5px] leading-4 font-bold whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-[15px]",
        icon || menu ? 'px-2.5' : 'px-3',
        active
          ? 'bg-accent-tint border-accent-primary/50 text-text-primary'
          : 'border-line-hairline text-text-secondary bg-(--fill-control) active:bg-surface-hover',
        className
      )}
      {...props}
    >
      {icon && (
        <span aria-hidden className="text-text-tertiary flex">
          {icon}
        </span>
      )}
      {children}
      {count !== undefined && (
        <span
          className={cn(
            'text-[12.5px] font-extrabold tabular-nums',
            active ? 'text-accent-text' : 'text-text-tertiary'
          )}
        >
          {count}
        </span>
      )}
      {menu && <ChevronDown aria-hidden className="text-text-tertiary size-3.5" />}
    </button>
  )
}

export interface FilterChipOption<T extends string> {
  value: T
  label: string
  count?: number
  icon?: React.ReactNode
}

type FilterChipsSelection<T extends string> =
  | {
      /** One choice: a radio group (one tab stop, the arrow keys move and select). */
      type: 'single'
      value: T
      onValueChange: (value: T) => void
    }
  | {
      /** Independent filters: toggle buttons with `aria-pressed`. */
      type: 'multiple'
      value: readonly T[]
      onValueChange: (value: T[]) => void
    }

/**
 * Filter chips (M66, M67): a sideways scroller of 36 chips, gap 8. `children` come after the
 * options, for chips that open a menu (`FilterChip menu`). The row carries `data-swipe-ignore`,
 * so a swipe on it scrolls the chips and opens no drawer. Put the screen padding in `className`
 * (`-mx-4 px-4` lets the chips scroll to the screen edge).
 */
export function FilterChips<T extends string>({
  label,
  options,
  className,
  children,
  ...selection
}: FilterChipsSelection<T> & {
  /** Accessible name of the options group. */
  label: string
  options: readonly FilterChipOption<T>[]
  className?: string
  children?: React.ReactNode
}): React.JSX.Element {
  const group = useRef<HTMLDivElement>(null)
  const single = selection.type === 'single'
  const current = single
    ? Math.max(
        options.findIndex((o) => o.value === selection.value),
        0
      )
    : -1

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (selection.type !== 'single') return
    const next = radioStep(current, options.length, e.key)
    if (next === null) return
    e.preventDefault()
    if (options[next].value !== selection.value) selection.onValueChange(options[next].value)
    const chip = group.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]
    chip?.focus()
    chip?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const toggle = (value: T): void => {
    if (selection.type !== 'multiple') return
    const on = selection.value.includes(value)
    selection.onValueChange(
      on ? selection.value.filter((v) => v !== value) : [...selection.value, value]
    )
  }

  return (
    <div
      data-slot="filter-chips"
      data-swipe-ignore=""
      className={cn(
        'flex gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    >
      <div
        ref={group}
        role={single ? 'radiogroup' : 'group'}
        aria-label={label}
        onKeyDown={onKeyDown}
        className="flex shrink-0 gap-2"
      >
        {options.map((o, i) => {
          if (selection.type === 'single') {
            const selected = i === current
            return (
              <FilterChip
                key={o.value}
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                active={selected}
                icon={o.icon}
                count={o.count}
                onClick={() => o.value !== selection.value && selection.onValueChange(o.value)}
              >
                {o.label}
              </FilterChip>
            )
          }
          const on = selection.value.includes(o.value)
          return (
            <FilterChip
              key={o.value}
              aria-pressed={on}
              active={on}
              icon={o.icon}
              count={o.count}
              onClick={() => toggle(o.value)}
            >
              {o.label}
            </FilterChip>
          )
        })}
      </div>
      {children}
    </div>
  )
}
