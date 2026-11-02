/**
 * The theme engine: a recipe (base colour, how much hue bleeds into the greys, how far apart the
 * steps sit, one accent) becomes seven surfaces, two hairlines, four text levels and the accent.
 * `you` and `live` are fixed and only re-resolve for the ground. Pure: no DOM.
 */

export type Ground = 'dark' | 'light'

export const RAMP_KEYS = [
  'window',
  'rail',
  'sheet',
  'raised',
  'sunken',
  'line',
  'lineStrong',
  'text',
  'text2',
  'text3',
  'text4',
  'accent'
] as const
export type RampKey = (typeof RAMP_KEYS)[number]

export interface ThemeRecipe {
  id: string
  name: string
  ground: Ground
  /** `#rrggbb` window colour the ramp grows from. */
  base: string
  /** 0..0.3: how much of the base hue bleeds into the greys. */
  tint: number
  /** 0.5..2.5: how far apart the surface steps sit. */
  separation: number
  accent: string
  /** Hand-set values that win over the derived ramp. */
  pins?: Partial<Record<RampKey, string>>
}

export interface ThemeTokens extends Record<RampKey, string> {
  ground: Ground
  hereText: string
  hereTint: string
  hereWash: string
  onHere: string
  you: string
  youText: string
  youTint: string
  onYou: string
  live: string
  liveText: string
  liveTint: string
  liveLine: string
  onLive: string
  ink: string
  onInk: string
  hover: string
  selected: string
  focus: string
  scrim: string
}

type Lch = [number, number, number]

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

function hexToLch(hex: string): Lch {
  const n = parseInt(hex.slice(1, 7), 16)
  const r = srgbToLinear(((n >> 16) & 255) / 255)
  const g = srgbToLinear(((n >> 8) & 255) / 255)
  const b = srgbToLinear((n & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  return [L, Math.hypot(a, bb), Math.atan2(bb, a)]
}

function lchToHex([L, C, h]: Lch): string {
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ]
  return (
    '#' +
    lin
      .map((c) =>
        Math.round(clamp01(linearToSrgb(clamp01(c))) * 255)
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
      .toUpperCase()
  )
}

const DARK_OFFSETS = {
  rail: 0.033,
  sheet: 0.056,
  raised: 0.095,
  sunken: 0.015,
  line: 0.112,
  lineStrong: 0.177
}
const LIGHT_OFFSETS = {
  rail: 0.024,
  sheet: 0.057,
  raised: 0.057,
  sunken: -0.021,
  line: -0.039,
  lineStrong: -0.104
}

const FIXED = {
  dark: {
    you: '#E8553C',
    youText: '#FF7A5E',
    youTint: '#E8553C1F',
    onYou: '#FFFFFF',
    live: '#2ED3C0',
    liveText: '#5FE3D3',
    liveTint: '#2ED3C01F',
    liveLine: '#2ED3C06B',
    onLive: '#04201C'
  },
  light: {
    you: '#CE4228',
    youText: '#B2351D',
    youTint: '#CE42281A',
    onYou: '#FFFFFF',
    live: '#0E8C7C',
    liveText: '#0A7567',
    liveTint: '#0E8C7C1A',
    liveLine: '#0E8C7C6B',
    onLive: '#FFFFFF'
  }
} as const

export function deriveTheme(recipe: ThemeRecipe): ThemeTokens {
  const dark = recipe.ground === 'dark'
  const [B, , hue] = hexToLch(recipe.base)
  const surfaceC = recipe.tint * 0.15
  const textC = recipe.tint * 0.12
  const offsets = dark ? DARK_OFFSETS : LIGHT_OFFSETS
  const surface = (offset: number): string =>
    lchToHex([clamp01(B + offset * recipe.separation), surfaceC, hue])
  const T = dark ? 0.961 : 0.195
  const fractions = dark ? [0.7, 0.5, 0.32] : [0.66, 0.45, 0.29]
  const text = (f: number): string => lchToHex([B + (T - B) * f, textC, hue])

  const ramp: Record<RampKey, string> = {
    window: recipe.base.toUpperCase(),
    rail: surface(offsets.rail),
    sheet: surface(offsets.sheet),
    raised: surface(offsets.raised),
    sunken: surface(offsets.sunken),
    line: surface(offsets.line),
    lineStrong: surface(offsets.lineStrong),
    text: lchToHex([T, textC, hue]),
    text2: text(fractions[0]),
    text3: text(fractions[1]),
    text4: text(fractions[2]),
    accent: recipe.accent.toUpperCase(),
    ...recipe.pins
  }

  const [aL, aC, aH] = hexToLch(ramp.accent)
  const fixed = FIXED[recipe.ground]
  return {
    ...ramp,
    ground: recipe.ground,
    hereText: dark
      ? lchToHex([Math.max(aL, 0.78), aC * 0.7, aH])
      : lchToHex([Math.min(aL, 0.45), aC, aH]),
    hereTint: ramp.accent + '20',
    hereWash: ramp.accent + '38',
    onHere: aL > 0.6 ? lchToHex([0.16, 0.02, aH]) : '#FFFFFF',
    ...fixed,
    ink: ramp.text,
    onInk: dark ? ramp.window : '#FFFFFF',
    hover: ramp.text + '0D',
    selected: ramp.text + '14',
    focus: ramp.accent + '99',
    scrim: dark ? '#06060799' : ramp.text + '59'
  }
}

export function themeVars(t: ThemeTokens): Record<string, string> {
  return {
    '--surface-window': t.window,
    '--surface-panel': t.rail,
    '--surface-content': t.sheet,
    '--surface-raised': t.raised,
    '--surface-sunken': t.sunken,
    '--line-hairline': t.line,
    '--line-strong': t.lineStrong,
    '--text-primary': t.text,
    '--text-secondary': t.text2,
    '--text-tertiary': t.text3,
    '--text-disabled': t.text4,
    '--here': t.accent,
    '--here-text': t.hereText,
    '--here-tint': t.hereTint,
    '--here-wash': t.hereWash,
    '--on-here': t.onHere,
    '--you': t.you,
    '--you-text': t.youText,
    '--you-tint': t.youTint,
    '--on-you': t.onYou,
    '--live': t.live,
    '--live-text': t.liveText,
    '--live-tint': t.liveTint,
    '--live-line': t.liveLine,
    '--on-live': t.onLive,
    '--ink': t.ink,
    '--on-ink': t.onInk,
    '--surface-hover': t.hover,
    '--surface-selected': t.selected,
    '--line-focus': t.focus,
    '--surface-scrim': t.scrim
  }
}

function block(selector: string, tokens: ThemeTokens): string {
  const body = Object.entries(themeVars(tokens))
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ')
  return `${selector} { ${body} }`
}

/** The `:root` prefix out-ranks the static `.dark` / `:root, .light` blocks in main.css, and nested
 *  `.light` / `.dark` scopes (swatches, colour probes) still get the active theme of their ground. */
export function themeCss(dark: ThemeTokens, light: ThemeTokens): string {
  return `${block(':root.dark, :root .dark', dark)}\n${block(':root.light, :root .light', light)}`
}
