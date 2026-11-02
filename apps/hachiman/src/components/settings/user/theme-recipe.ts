import {
  deriveTheme,
  RAMP_KEYS,
  type Ground,
  type RampKey,
  type ThemeRecipe
} from '@/lib/theme-engine'
import { DEFAULT_DARK, DEFAULT_LIGHT, findTheme, isThemeRecipe } from '@/lib/theme-presets'

export const newThemeId = (): string => `custom-${crypto.randomUUID()}`

/**
 * A copy to edit. Presets pin every ramp key, so a fork drops the pins or the sliders would do
 * nothing; the derived ramp matches the pinned one within the engine's tolerance.
 */
export function forkTheme(from: ThemeRecipe, name = `${from.name} copy`): ThemeRecipe {
  return { ...from, id: newThemeId(), name, pins: undefined }
}

const defaultOf = (ground: Ground): ThemeRecipe => {
  const recipe = findTheme(ground === 'dark' ? DEFAULT_DARK : DEFAULT_LIGHT, [])
  if (!recipe) throw new Error('default theme missing')
  return recipe
}

/**
 * The same recipe on the other ground: the base of that ground's default theme, tint and
 * separation kept. The accent follows only while it is still the old ground's default accent. A
 * pinned surface stays pinned, it just carries a value for the new ground.
 */
export function switchGround(r: ThemeRecipe, ground: Ground): ThemeRecipe {
  if (r.ground === ground) return r
  const from = defaultOf(r.ground)
  const to = defaultOf(ground)
  const next: ThemeRecipe = {
    ...r,
    ground,
    base: to.base,
    accent: r.accent.toUpperCase() === from.accent.toUpperCase() ? to.accent : r.accent,
    pins: undefined
  }
  if (!r.pins) return next
  const derived = deriveTheme(next)
  const pins: Partial<Record<RampKey, string>> = {}
  for (const key of Object.keys(r.pins) as RampKey[]) pins[key] = derived[key]
  return { ...next, pins }
}

/** The recipe as text to copy, without its id. */
export function shareText(r: ThemeRecipe): string {
  const rest: Partial<ThemeRecipe> = { ...r }
  delete rest.id
  return JSON.stringify(rest)
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** A recipe from text made by `shareText`, with a new id; null for anything else. */
export function parseShared(text: string): ThemeRecipe | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const candidate = { ...(raw as Record<string, unknown>), id: newThemeId() }
  if (!isThemeRecipe(candidate)) return null
  return {
    ...candidate,
    name: candidate.name.slice(0, 40),
    tint: clamp(candidate.tint, 0, 0.3),
    separation: clamp(candidate.separation, 0.5, 2.5)
  }
}

export const RAMP_LABEL: Record<RampKey, string> = {
  window: 'Window',
  rail: 'Rail',
  sheet: 'Sheet',
  raised: 'Raised',
  sunken: 'Sunken',
  line: 'Hairline',
  lineStrong: 'Hairline +',
  text: 'Text',
  text2: 'Text 2',
  text3: 'Text 3',
  text4: 'Text 4',
  accent: 'Accent'
}

export const SURFACE_KEYS: readonly RampKey[] = RAMP_KEYS.slice(0, 7)
export const TEXT_KEYS: readonly RampKey[] = RAMP_KEYS.slice(7)
