import { useMemo } from 'react'
import { Lock } from 'lucide-react'
import { deriveTheme, themeVars, type ThemeRecipe } from '@/lib/theme-engine'
import { cn } from '@/lib/utils'

/**
 * A small picture of the app in `recipe`, painted with that theme's own variables. It shows every
 * surface, the `here` mark, the `you` row and the `live` pill.
 */
export function ThemeMock({
  recipe,
  className
}: {
  recipe: ThemeRecipe
  className?: string
}): React.JSX.Element {
  const vars = useMemo(() => themeVars(deriveTheme(recipe)), [recipe])
  return (
    <div
      aria-hidden
      style={vars}
      className={cn(
        'border-line-hairline bg-surface-window flex overflow-hidden rounded-[8px] border',
        className
      )}
    >
      <div className="bg-surface-panel flex w-[90px] shrink-0 flex-col gap-1.5 px-2 py-2.5">
        <span className="bg-surface-selected h-[7px] w-full rounded-[2px]" />
        <span className="bg-surface-selected h-[7px] w-[70%] rounded-[2px]" />
        <span className="bg-here-tint flex h-4 items-center gap-1.5 rounded-[4px] px-[5px]">
          <span className="bg-here h-[9px] w-[3px] rounded-[1px]" />
          <span className="bg-text-secondary h-[5px] w-9 rounded-[2px]" />
        </span>
        <span className="bg-surface-selected h-[7px] w-full rounded-[2px]" />
        <span className="bg-surface-selected h-[7px] w-[60%] rounded-[2px]" />
      </div>
      <div className="bg-surface-content flex min-w-0 flex-1 flex-col gap-2 px-3 py-[11px]">
        <div className="flex items-center gap-2">
          <span className="bg-line-strong size-[13px] shrink-0 rounded-full" />
          <span className="bg-text-tertiary h-[5px] w-[150px] max-w-full rounded-[2px]" />
        </div>
        <div className="flex items-center gap-2">
          <span className="bg-line-strong size-[13px] shrink-0 rounded-full" />
          <span className="bg-text-tertiary h-[5px] w-[112px] max-w-full rounded-[2px]" />
        </div>
        <div className="border-you bg-you-tint flex h-[26px] items-center gap-[7px] rounded-[4px] border px-[7px]">
          <span className="bg-you size-[7px] shrink-0 rounded-full" />
          <span className="bg-text-secondary h-[5px] w-[110px] max-w-full rounded-[2px]" />
        </div>
        <span className="bg-live-tint rounded-pill flex w-fit items-center gap-1.5 px-[7px] py-[3px]">
          <span className="bg-live size-[5px] rounded-full" />
          <span className="text-live-text font-mono text-[7px] font-semibold tracking-[1px]">
            LIVE
          </span>
        </span>
        <span className="flex-1" />
        <div className="border-line-hairline bg-surface-raised flex h-[22px] items-center rounded-[5px] border px-2">
          <span className="bg-text-disabled h-1 w-[70px] rounded-[2px]" />
          <span className="bg-here ml-auto size-3 rounded-full" />
        </div>
      </div>
    </div>
  )
}

/** The two answers no theme changes: what is about you and what is happening now. */
export function LockedHues({
  size,
  note
}: {
  size: 'desktop' | 'compact' | 'mobile'
  note?: React.ReactNode
}): React.JSX.Element {
  const mobile = size === 'mobile'
  const compact = size === 'compact'
  const chips = [
    { dot: 'bg-you', title: 'About you', desc: 'mentions, unreads, your draft', short: 'YOU' },
    { dot: 'bg-live', title: 'Happening now', desc: 'voice, typing, recording', short: 'LIVE' }
  ]
  return (
    <div className="grid gap-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <Lock aria-hidden className="text-text-disabled size-[13px]" />
        <span className="text-text-disabled font-mono text-[8.5px] tracking-[1.4px] uppercase">
          {mobile ? 'Not yours to set' : compact ? 'Not theirs to set' : 'No theme changes these'}
        </span>
        {chips.map((c) =>
          mobile ? (
            <span
              key={c.short}
              className="border-line-hairline rounded-pill flex items-center gap-1.5 border px-2 py-1"
            >
              <span className={cn('size-2.5 rounded-full', c.dot)} />
              <span className="text-text-tertiary font-mono text-[8px]">{c.short}</span>
            </span>
          ) : (
            <span
              key={c.short}
              className={cn(
                'rounded-control border-line-hairline flex items-center gap-[9px] border',
                compact ? 'px-2.5 py-1.5' : 'px-[11px] py-[7px]'
              )}
            >
              <span className={cn('rounded-full', c.dot, compact ? 'size-3' : 'size-3.5')} />
              <span className="text-text-secondary text-[12px] font-semibold">{c.title}</span>
              {!compact && (
                <span className="text-text-disabled font-mono text-[8px] tracking-[0.4px]">
                  {c.desc}
                </span>
              )}
            </span>
          )
        )}
      </div>
      {note && <p className="text-text-disabled text-[11.5px]">{note}</p>}
    </div>
  )
}
