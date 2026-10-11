import { useLayoutEffect, useRef } from 'react'
import { radioStep } from '@/lib/roving'
import { cn } from '@/lib/utils'

export interface SectionTab {
  id: string
  label: string
  /** A count after the label ("Roles 5"); 0 shows none. */
  count?: number
}

/** Up to this many tabs share the width. More scroll sideways at their own width. */
const FILL_MAX = 4

/**
 * The section tabs of a settings screen on the window under the Nav Bar (M52): a 48 strip,
 * padding 0/12, gap 6, tabs 36 (r8, label 14, count 12/700). The picked tab has the content
 * colour and a hairline edge. A tablist: one tab stop, the arrow keys move and pick. The strip
 * carries `data-swipe-ignore`, so a sideways swipe scrolls it and opens no drawer.
 *
 * Tab `id` is `${idBase}-${tab.id}` and the panel's is `${idBase}-panel`, so the panel can name
 * its tab (`aria-labelledby`).
 */
export function SectionTabs({
  label,
  tabs,
  value,
  onValueChange,
  idBase
}: {
  /** Accessible name of the tablist. */
  label: string
  tabs: readonly SectionTab[]
  value: string | undefined
  onValueChange: (id: string) => void
  idBase: string
}): React.JSX.Element {
  const strip = useRef<HTMLDivElement>(null)
  const fill = tabs.length <= FILL_MAX
  const current = Math.max(
    tabs.findIndex((t) => t.id === value),
    0
  )

  // Keep the picked tab in view, also when another screen picked it.
  useLayoutEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [value])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const next = radioStep(current, tabs.length, e.key)
    if (next === null) return
    e.preventDefault()
    if (tabs[next].id !== value) onValueChange(tabs[next].id)
    strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus()
  }

  return (
    <div
      ref={strip}
      role="tablist"
      aria-label={label}
      data-slot="section-tabs"
      data-swipe-ignore=""
      onKeyDown={onKeyDown}
      className="flex h-12 shrink-0 items-center gap-1.5 overflow-x-auto overscroll-x-contain px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map((t, i) => {
        const selected = i === current
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${idBase}-${t.id}`}
            aria-selected={selected}
            aria-controls={selected ? `${idBase}-panel` : undefined}
            tabIndex={selected ? 0 : -1}
            onClick={() => t.id !== value && onValueChange(t.id)}
            className={cn(
              'rounded-control flex h-9 items-center justify-center gap-[5px] border text-[14px] leading-[18px] whitespace-nowrap outline-none transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-line-focus',
              fill ? 'min-w-0 flex-1 px-2' : 'shrink-0 px-3',
              selected
                ? 'bg-surface-content border-line-strong text-text-primary font-extrabold'
                : 'text-text-secondary active:bg-surface-hover border-transparent bg-(--fill-control) font-semibold'
            )}
          >
            <span className="truncate">{t.label}</span>
            {t.count !== undefined && t.count > 0 && (
              <span className="text-text-tertiary text-[12px] leading-4 font-bold tabular-nums">
                {t.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
