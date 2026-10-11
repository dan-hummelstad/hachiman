import { hashString } from '@/lib/hash'

/**
 * Guild tint (docs/arc-new-features-plan.md N4): the window wallpaper takes one hue per guild.
 * The hue is the most common saturated hue of the guild icon. A guild with no icon, or an icon
 * that has no saturated pixel or does not load, gets a hue from a hash of its id.
 * The tint has a fixed saturation and lightness per theme, so the contrast stays the same.
 */

/** Hues of the feature colours (accent, voice, event, page, thread, danger, activity, bot). */
export const FALLBACK_HUES = [247, 150, 37, 265, 201, 354, 330, 173] as const

const BINS = 36
const BIN_SIZE = 360 / BINS
/** Pixels below this saturation, or outside the lightness band, are grey: they carry no hue. */
const MIN_SATURATION = 0.25
const MIN_LIGHTNESS = 0.12
const MAX_LIGHTNESS = 0.9
const MIN_ALPHA = 128

/** Hue (0–360), saturation and lightness (0–1) of an RGB colour (0–255 channels). */
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === rn) h = ((gn - bn) / d) % 6
  else if (max === gn) h = (bn - rn) / d + 2
  else h = (rn - gn) / d + 4
  h *= 60
  return [h < 0 ? h + 360 : h, s, l]
}

/**
 * The dominant saturated hue of RGBA pixels (as from `getImageData`), or null when no pixel
 * is saturated. Each pixel votes for its 10° bin with its saturation as the weight. The result
 * is the weighted circular mean of the hues in the winning bin.
 */
export function dominantHue(rgba: ArrayLike<number>): number | null {
  const weight = new Float64Array(BINS)
  const sin = new Float64Array(BINS)
  const cos = new Float64Array(BINS)
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if ((rgba[i + 3] ?? 0) < MIN_ALPHA) continue
    const [h, s, l] = rgbToHsl(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0)
    if (s < MIN_SATURATION || l < MIN_LIGHTNESS || l > MAX_LIGHTNESS) continue
    const bin = Math.min(BINS - 1, Math.floor(h / BIN_SIZE))
    const rad = (h * Math.PI) / 180
    weight[bin] = (weight[bin] ?? 0) + s
    sin[bin] = (sin[bin] ?? 0) + s * Math.sin(rad)
    cos[bin] = (cos[bin] ?? 0) + s * Math.cos(rad)
  }
  let best = -1
  for (let b = 0; b < BINS; b++)
    if ((weight[b] ?? 0) > (best < 0 ? 0 : (weight[best] ?? 0))) best = b
  if (best < 0) return null
  const deg = (Math.atan2(sin[best] ?? 0, cos[best] ?? 0) * 180) / Math.PI
  return Math.round(deg < 0 ? deg + 360 : deg) % 360
}

/** A hue from the feature palette, chosen by a hash (FNV-1a) of the guild id. */
export function fallbackHue(guildId: string): number {
  return FALLBACK_HUES[hashString(guildId) % FALLBACK_HUES.length] ?? FALLBACK_HUES[0]
}

/** The Arc wallpaper of each theme (B1, B2): the base that a guild hue washes over. */
const BASE = { light: '#e4e0fe', dark: '#201c46' } as const
/** How much of the guild hue the wallpaper takes. More reads as a coloured window, not a wash. */
const WASH = 30

/**
 * The wallpaper colours of a hue: a faint wash of the hue (fixed saturation and lightness per
 * theme) over the Arc base, so every guild stays close to B1/B8/B10.
 */
export function tintColors(hue: number): { light: string; dark: string } {
  const wash = (color: string, base: string): string =>
    `color-mix(in oklab, ${color} ${WASH}%, ${base})`
  return {
    light: wash(`hsl(${hue} 45% 91%)`, BASE.light),
    dark: wash(`hsl(${hue} 42% 17%)`, BASE.dark)
  }
}

/** The window wallpaper of a tint colour: the tint at the top, fading into the window surface. */
export function tintWallpaper(tint: string): string {
  return `linear-gradient(180deg, ${tint}, color-mix(in oklab, ${tint} 45%, var(--surface-window)))`
}

/** The tint of the DM space, and of the screens before the shell (no guild). */
export const HOME_TINT = 'var(--tint-home)'
/** The window wallpaper of `HOME_TINT`. */
export const HOME_WALLPAPER = tintWallpaper(HOME_TINT)

/** One colour of a custom gradient: hue 0–360 and saturation 0–100. */
export interface GradientStop {
  h: number
  s: number
}

/**
 * A user's own wallpaper (User settings → Appearance): 1 to 3 stops, one lightness (0–100) for
 * all of them, and a CSS angle in degrees.
 */
export interface CustomGradient {
  stops: GradientStop[]
  lightness: number
  angle: number
}

export const DEFAULT_CUSTOM_GRADIENT: CustomGradient = {
  stops: [
    { h: 247, s: 88 },
    { h: 201, s: 90 }
  ],
  lightness: 62,
  angle: 135
}

export const MAX_GRADIENT_STOPS = 3
export const LIGHTNESS_RANGE = [15, 90] as const

export function stopColor({ h, s }: GradientStop, lightness: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(lightness)}%)`
}

/** True when `v` is a usable gradient (a stored pref can predate this shape). */
export function isCustomGradient(v: unknown): v is CustomGradient {
  if (typeof v !== 'object' || v === null) return false
  const g = v as Partial<CustomGradient>
  return (
    Array.isArray(g.stops) &&
    g.stops.length >= 1 &&
    g.stops.length <= MAX_GRADIENT_STOPS &&
    g.stops.every((st) => Number.isFinite(st?.h) && Number.isFinite(st?.s)) &&
    Number.isFinite(g.lightness) &&
    Number.isFinite(g.angle)
  )
}

/**
 * The window wallpaper of a custom gradient. Each colour is washed over the window surface of
 * the theme by the same amount as a guild hue, so the text on the wallpaper keeps its contrast
 * for any colour, and one value serves both themes.
 */
export function customWallpaper({ stops, lightness, angle }: CustomGradient): string {
  const colors = stops.map(
    (st) => `color-mix(in oklab, ${stopColor(st, lightness)} ${WASH}%, var(--surface-window))`
  )
  if (colors.length === 1) colors.push(colors[0])
  return `linear-gradient(${Math.round(angle)}deg, ${colors.join(', ')})`
}

/**
 * The solid colour at the top of a custom wallpaper: its first stop, washed as `customWallpaper`
 * washes it. One value serves both themes.
 */
export function customWindowColor({ stops, lightness }: CustomGradient): string {
  const first = stops[0]
  return first
    ? `color-mix(in oklab, ${stopColor(first, lightness)} ${WASH}%, var(--surface-window))`
    : 'var(--surface-window)'
}

const ICON_SAMPLE = 32

/**
 * Decode an image URL into a canvas and return its dominant hue. Null when the image does not
 * load, the canvas is tainted (no CORS), or no pixel is saturated. Browser only.
 */
export function decodeIconHue(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = ICON_SAMPLE
        canvas.height = ICON_SAMPLE
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return resolve(null)
        ctx.drawImage(img, 0, 0, ICON_SAMPLE, ICON_SAMPLE)
        resolve(dominantHue(ctx.getImageData(0, 0, ICON_SAMPLE, ICON_SAMPLE).data))
      } catch {
        resolve(null)
      }
    }
    img.onerror = () => resolve(null)
    img.src = url
  })
}
