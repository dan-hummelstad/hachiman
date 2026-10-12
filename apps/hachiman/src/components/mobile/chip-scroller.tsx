import { useLayoutEffect, useRef } from 'react'
import { FilterChip } from '@/components/mobile/filter-chips'
import { radioStep } from '@/lib/roving'
import { cn } from '@/lib/utils'

/**
 * The `scrollLeft` that shows an item whole, `inset` clear of both edges of the view. The item's
 * `start` and `end` are in scroll content coordinates. Null when the item shows already. An item
 * wider than the view shows from its start.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function revealScrollLeft(
  view: { scrollLeft: number; width: number },
  item: { start: number; end: number },
  inset = 0
): number | null {
  const from = view.scrollLeft + inset
  const to = view.scrollLeft + view.width - inset
  if (item.start >= from && item.end <= to) return null
  const tooWide = item.end - item.start > view.width - 2 * inset
  if (item.start < from || tooWide) return Math.max(0, item.start - inset)
  return item.end - view.width + inset
}

export interface ChipScrollerOption<T extends string> {
  value: T
  label: string
  /** An icon (15) or a dot before the label. */
  lead?: React.ReactNode
  /** The count chip after the label. None for 0. */
  count?: number
}

/**
 * One choice from a sideways row of 38 chips (the override targets of M49): a radio group with
 * one tab stop, where the arrow keys move and select. The selected chip scrolls into view when it
 * changes, also when the caller changes it (a new chip at the end). The row carries
 * `data-swipe-ignore`, so a swipe on it scrolls the chips and opens no drawer. Put the screen
 * padding in `className` (`-mx-4 px-4` lets the chips scroll to the screen edge). The padding is
 * also the margin of a chip that scrolls into view.
 */
export function ChipScroller<T extends string>({
  label,
  options,
  value,
  onValueChange,
  className
}: {
  /** Accessible name of the group. */
  label: string
  options: readonly ChipScrollerOption<T>[]
  value: T
  onValueChange: (value: T) => void
  className?: string
}): React.JSX.Element {
  const row = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const current = Math.max(
    options.findIndex((o) => o.value === value),
    0
  )

  useLayoutEffect(() => {
    const box = row.current
    const chip = box?.querySelectorAll<HTMLElement>('[role="radio"]')[current]
    if (!box || !chip) return
    const first = !mounted.current
    mounted.current = true
    const boxLeft = box.getBoundingClientRect().left + box.clientLeft
    const rect = chip.getBoundingClientRect()
    const start = rect.left - boxLeft + box.scrollLeft
    const left = revealScrollLeft(
      { scrollLeft: box.scrollLeft, width: box.clientWidth },
      { start, end: start + rect.width },
      parseFloat(getComputedStyle(box).paddingLeft) || 0
    )
    // The first reveal is instant; later ones follow the row's `scroll-behavior`.
    if (left !== null) box.scrollTo({ left, behavior: first ? 'instant' : 'auto' })
  }, [current, options.length])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const next = radioStep(current, options.length, e.key)
    if (next === null) return
    e.preventDefault()
    if (options[next].value !== value) onValueChange(options[next].value)
    row.current?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus()
  }

  return (
    <div
      ref={row}
      role="radiogroup"
      aria-label={label}
      data-slot="chip-scroller"
      data-swipe-ignore=""
      onKeyDown={onKeyDown}
      className={cn(
        'flex shrink-0 gap-2 overflow-x-auto overscroll-x-contain scroll-smooth [scrollbar-width:none] motion-reduce:scroll-auto [&::-webkit-scrollbar]:hidden',
        className
      )}
    >
      {options.map((o, i) => {
        const selected = i === current
        return (
          <FilterChip
            key={o.value}
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            active={selected}
            onClick={() => o.value !== value && onValueChange(o.value)}
            className={cn(
              'h-[38px] gap-[7px] px-[11px] text-[14.5px] leading-4',
              selected ? 'font-bold' : 'font-semibold'
            )}
          >
            {o.lead && (
              <span
                aria-hidden
                className={cn('flex', selected ? 'text-accent-text' : 'text-text-tertiary')}
              >
                {o.lead}
              </span>
            )}
            <span className="max-w-48 truncate">{o.label}</span>
            {o.count !== undefined && o.count > 0 && (
              <span
                className={cn(
                  'flex h-[18px] items-center rounded-[5px] px-1.5 text-[11px] leading-none font-extrabold tabular-nums',
                  selected
                    ? 'bg-accent-primary/30 text-text-primary'
                    : 'bg-fill-control-strong text-text-secondary'
                )}
              >
                {o.count}
              </span>
            )}
          </FilterChip>
        )
      })}
    </div>
  )
}
