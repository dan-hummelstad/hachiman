import { useCallback, useMemo, useState } from 'react'
import { useMediaQuery } from '@/hooks/use-media-query'
import type { Ground, RampKey, ThemeRecipe } from '@/lib/theme-engine'
import { DEFAULT_DARK, DEFAULT_LIGHT, findTheme, THEME_PRESETS } from '@/lib/theme-presets'
import { DARK_QUERY, resolveTheme } from '@/lib/theme'
import { usePrefsStore } from '@/stores/prefsStore'

export interface ActiveThemes {
  /** The theme of each ground slot. */
  dark: ThemeRecipe
  light: ThemeRecipe
  /** The one in use right now. */
  active: ThemeRecipe
  ground: Ground
  /** The ground preference: dark, light or system. */
  theme: 'dark' | 'light' | 'system'
  custom: ThemeRecipe[]
  /** Presets, then the user's own. */
  all: ThemeRecipe[]
  /** The theme of this ground is in use right now. */
  inUse: (recipe: ThemeRecipe) => boolean
  /** Use this theme: the slot of its ground, and the ground itself unless following the system. */
  pickTheme: (recipe: ThemeRecipe) => void
}

function preset(id: string): ThemeRecipe {
  const recipe = findTheme(id, [])
  if (!recipe) throw new Error(`missing preset ${id}`)
  return recipe
}

export function useActiveThemes(): ActiveThemes {
  const theme = usePrefsStore((s) => s.theme)
  const darkId = usePrefsStore((s) => s.darkTheme)
  const lightId = usePrefsStore((s) => s.lightTheme)
  const custom = usePrefsStore((s) => s.customThemes)
  const setDarkTheme = usePrefsStore((s) => s.setDarkTheme)
  const setLightTheme = usePrefsStore((s) => s.setLightTheme)
  const applyTheme = usePrefsStore((s) => s.applyTheme)
  const osDark = useMediaQuery(DARK_QUERY)
  const ground = resolveTheme(theme, osDark)

  const dark = useMemo(() => findTheme(darkId, custom) ?? preset(DEFAULT_DARK), [darkId, custom])
  const light = useMemo(
    () => findTheme(lightId, custom) ?? preset(DEFAULT_LIGHT),
    [lightId, custom]
  )
  const all = useMemo(() => [...THEME_PRESETS, ...custom], [custom])

  const inUse = useCallback(
    (r: ThemeRecipe): boolean => {
      const slot = r.ground === 'dark' ? dark : light
      return slot.id === r.id && (theme === 'system' || theme === r.ground)
    },
    [dark, light, theme]
  )
  const pickTheme = useCallback(
    (r: ThemeRecipe): void => {
      if (theme === 'system') {
        if (r.ground === 'dark') setDarkTheme(r.id)
        else setLightTheme(r.id)
      } else applyTheme(r.id)
    },
    [theme, setDarkTheme, setLightTheme, applyTheme]
  )

  return {
    dark,
    light,
    active: ground === 'dark' ? dark : light,
    ground,
    theme,
    custom,
    all,
    inUse,
    pickTheme
  }
}

export interface ThemeDraft {
  draft: ThemeRecipe
  patch: (p: Partial<ThemeRecipe>) => void
  /** A hex pins the key; null lets the engine derive it again. */
  setPin: (key: RampKey, hex: string | null) => void
  reset: () => void
  dirty: boolean
  /** Saves the draft and uses it. */
  save: () => void
}

/** The recipe being edited. Nothing reaches the app until `save`. */
export function useThemeDraft(initial: ThemeRecipe): ThemeDraft {
  const saveCustomTheme = usePrefsStore((s) => s.saveCustomTheme)
  const { pickTheme } = useActiveThemes()
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState(initial)
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved)

  const patch = useCallback(
    (p: Partial<ThemeRecipe>): void => setDraft((d) => ({ ...d, ...p })),
    []
  )
  const setPin = useCallback((key: RampKey, hex: string | null): void => {
    setDraft((d) => {
      const pins = { ...d.pins }
      if (hex === null) delete pins[key]
      else pins[key] = hex.toUpperCase()
      return { ...d, pins: Object.keys(pins).length > 0 ? pins : undefined }
    })
  }, [])
  const reset = useCallback((): void => setDraft(saved), [saved])
  const save = useCallback((): void => {
    saveCustomTheme(draft)
    pickTheme(draft)
    setSaved(draft)
  }, [draft, saveCustomTheme, pickTheme])

  return { draft, patch, setPin, reset, dirty, save }
}
