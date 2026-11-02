import { useState } from 'react'
import { Download, Pencil, Plus } from 'lucide-react'
import { MobileCard, ToggleRow } from '@/components/settings/user/rows'
import { forkTheme, parseShared } from '@/components/settings/user/theme-recipe'
import { LockedHues, ThemeMock } from '@/components/settings/user/theme-mock'
import { useActiveThemes } from '@/components/settings/user/use-themes'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { ThemeRecipe } from '@/lib/theme-engine'
import { cn } from '@/lib/utils'
import { usePrefsStore } from '@/stores/prefsStore'

type Filter = 'all' | 'yours'

const FILTERS = [
  { value: 'all', label: 'All', selectedClassName: 'bg-here text-on-here' },
  { value: 'yours', label: 'Yours', selectedClassName: 'bg-here text-on-here' }
] as const

const META = 'text-text-disabled font-mono text-[8px] tracking-[1px] uppercase'

function metaOf(r: ThemeRecipe, custom: boolean): string {
  return `${r.ground === 'dark' ? 'Dark' : 'Light'} · ${custom ? 'Yours' : 'Built in'}`
}

/** "Match the system": follow the OS ground, each ground with its own theme. */
function MatchSystem({ mobile }: { mobile?: boolean }): React.JSX.Element {
  const { theme, dark, light, ground } = useActiveThemes()
  const setTheme = usePrefsStore((s) => s.setTheme)
  const row = (
    <ToggleRow
      title="Match the system"
      hint={`Use ${dark.name} while the system is dark and ${light.name} while it is light.`}
      checked={theme === 'system'}
      onChange={(on) => setTheme(on ? 'system' : ground)}
    />
  )
  return mobile ? <MobileCard>{row}</MobileCard> : row
}

function ThemeCardDesktop({
  recipe,
  custom,
  on,
  onPick,
  onEdit
}: {
  recipe: ThemeRecipe
  custom: boolean
  on: boolean
  onPick: () => void
  onEdit: () => void
}): React.JSX.Element {
  return (
    <div
      role="radio"
      aria-checked={on}
      aria-label={recipe.name}
      tabIndex={0}
      onClick={onPick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      }}
      className={cn(
        'flex cursor-pointer flex-col gap-[11px] rounded-[10px] border p-[11px] text-left outline-none focus-visible:outline-2 focus-visible:outline-line-focus',
        on ? 'border-here bg-here-tint' : 'border-line-hairline hover:bg-surface-hover'
      )}
    >
      <ThemeMock recipe={recipe} className="h-[138px]" />
      <div className="flex items-center gap-2.5 px-[3px] pb-0.5">
        <span className="min-w-0 flex-1">
          <span className="text-text-primary block truncate text-[14px] font-semibold">
            {recipe.name}
          </span>
          <span className={META}>{metaOf(recipe, custom)}</span>
        </span>
        {custom && (
          <span onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
            <IconButton label={`Edit ${recipe.name}`} size="sm" onClick={onEdit}>
              <Pencil />
            </IconButton>
          </span>
        )}
        <span
          aria-hidden
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-full',
            on ? 'bg-here' : 'border-line-strong border-[1.5px]'
          )}
        >
          {on && <span className="bg-on-here size-[7px] rounded-full" />}
        </span>
      </div>
    </div>
  )
}

/** The desktop gallery: pick a theme, import one, or start a new one from the one in use. */
export function ThemeGallery({
  onEdit
}: {
  onEdit: (recipe: ThemeRecipe) => void
}): React.JSX.Element {
  const { all, custom, active, inUse, pickTheme } = useActiveThemes()
  const saveCustomTheme = usePrefsStore((s) => s.saveCustomTheme)
  const [filter, setFilter] = useState<Filter>('all')
  const [importError, setImportError] = useState(false)
  const customIds = new Set(custom.map((c) => c.id))
  const shown = filter === 'all' ? all : custom

  const importFromClipboard = async (): Promise<void> => {
    setImportError(false)
    try {
      const recipe = parseShared(await navigator.clipboard.readText())
      if (!recipe) throw new Error('not a theme')
      saveCustomTheme(recipe)
    } catch {
      setImportError(true)
    }
  }

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <SegmentedControl
          label="Show themes"
          options={FILTERS}
          value={filter}
          onChange={setFilter}
          className="w-fit"
        />
        <span className="ml-auto flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => void importFromClipboard()}>
            <Download aria-hidden /> Import
          </Button>
          <Button size="sm" onClick={() => onEdit(forkTheme(active))}>
            <Plus aria-hidden /> New theme
          </Button>
        </span>
      </div>
      {importError && (
        <p role="alert" className="text-you-text text-[12.5px]">
          The clipboard holds no theme. Copy one with Share first.
        </p>
      )}
      {filter === 'yours' && custom.length === 0 && (
        <p className="text-text-tertiary text-[13px]">Themes you make or import show here.</p>
      )}
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-3 items-start gap-3.5">
        {shown.map((r) => (
          <ThemeCardDesktop
            key={r.id}
            recipe={r}
            custom={customIds.has(r.id)}
            on={inUse(r)}
            onPick={() => pickTheme(r)}
            onEdit={() => onEdit(r)}
          />
        ))}
        <button
          type="button"
          onClick={() => onEdit(forkTheme(active))}
          className="border-line-strong hover:bg-surface-hover flex h-[116px] flex-col items-center justify-center gap-2 rounded-[10px] border"
        >
          <span className="border-line-strong flex size-11 items-center justify-center rounded-full border">
            <Plus aria-hidden className="text-text-tertiary size-[19px]" />
          </span>
          <span className="text-text-secondary text-[14px] font-semibold">New theme</span>
          <span className={META}>Start from {active.name}</span>
        </button>
      </div>
      <MatchSystem />
      <div className="bg-line-hairline h-px" aria-hidden />
      <LockedHues
        size="desktop"
        note="They only re-resolve for the ground, so they are never the same value twice and always the same meaning."
      />
    </div>
  )
}

/** The phone list of themes (a card each), then the locked hues and "New theme". */
export function ThemeListMobile({
  onEdit
}: {
  onEdit: (recipe: ThemeRecipe) => void
}): React.JSX.Element {
  const { all, custom, active, inUse, pickTheme } = useActiveThemes()
  const customIds = new Set(custom.map((c) => c.id))
  return (
    <div className="flex flex-col gap-3">
      <div role="radiogroup" aria-label="Theme" className="flex flex-col gap-3">
        {all.map((r) => {
          const on = inUse(r)
          const mine = customIds.has(r.id)
          return (
            <div
              key={r.id}
              className={cn(
                'flex items-center gap-3 rounded-[16px] border p-2.5',
                on ? 'bg-here-tint border-here' : 'border-line-hairline active:bg-surface-hover'
              )}
            >
              <button
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={r.name}
                onClick={() => pickTheme(r)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <ThemeMock recipe={r} className="h-[78px] w-[132px] shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="text-text-primary block truncate text-[15.5px] font-semibold">
                    {r.name}
                  </span>
                  <span className={META}>
                    {r.ground === 'dark' ? 'Dark' : 'Light'}
                    {mine ? ' · Yours' : ''}
                  </span>
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-[22px] shrink-0 items-center justify-center rounded-full',
                    on ? 'bg-here' : 'border-line-strong border-[1.5px]'
                  )}
                >
                  {on && <span className="bg-on-here size-2 rounded-full" />}
                </span>
              </button>
              {mine && (
                <IconButton label={`Edit ${r.name}`} size="touch" onClick={() => onEdit(r)}>
                  <Pencil />
                </IconButton>
              )}
            </div>
          )
        })}
      </div>
      <LockedHues size="mobile" />
      <Button size="mobile" variant="secondary" onClick={() => onEdit(forkTheme(active))}>
        <Plus aria-hidden /> New theme
      </Button>
      <MatchSystem mobile />
    </div>
  )
}
