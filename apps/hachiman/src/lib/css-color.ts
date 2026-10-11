/**
 * CSS colours as hex, for the native side (`IPlatformService.setAppearance` takes only hex). The
 * app colours are `var()` tokens and `color-mix()` strings (`lib/guild-tint.ts`).
 */

export type Rgba = [r: number, g: number, b: number, a: number]

/** `#rrggbb`, or `#rrggbbaa` when the colour is not opaque. Channels 0–255. */
export function rgbaToHex([r, g, b, a]: Rgba): string {
  const byte = (n: number): string =>
    Math.round(Math.min(255, Math.max(0, n)))
      .toString(16)
      .padStart(2, '0')
  return `#${byte(r)}${byte(g)}${byte(b)}${a >= 255 ? '' : byte(a)}`
}

const RGB =
  /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)(%?)\s*)?\)$/i

/**
 * The channels (alpha 0–255) of an `rgb()` or `rgba()` value, the form that a computed style
 * gives for an sRGB colour. Null for any other form.
 */
export function parseRgb(value: string): Rgba | null {
  const m = RGB.exec(value.trim())
  if (!m) return null
  const alpha = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1)
  return [Number(m[1]), Number(m[2]), Number(m[3]), Math.round(Math.min(1, alpha) * 255)]
}

/** A colour that the canvas can parse, painted on one pixel and read back. */
function paint(color: string): Rgba | null {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  // `fillStyle` keeps its old value when it cannot parse the new one: two sentinels tell that
  // apart from a colour that equals one of them.
  ctx.fillStyle = '#000000'
  ctx.fillStyle = color
  const first = ctx.fillStyle
  ctx.fillStyle = '#ffffff'
  ctx.fillStyle = color
  if (ctx.fillStyle !== first) return null
  ctx.fillRect(0, 0, 1, 1)
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data
  return [r, g, b, a]
}

/**
 * Any CSS colour (`var()`, `color-mix()`, `oklab()`, ...) as hex, with the tokens of `theme`.
 * A probe element with the theme class (`.light` and `.dark` scope the tokens, assets/main.css)
 * resolves the value. A computed form other than `rgb()` goes through a 1 px canvas. Null when
 * the value is not a colour or is fully transparent. Browser only.
 */
export function resolveCssColor(color: string, theme: 'dark' | 'light'): string | null {
  const probe = document.createElement('div')
  probe.className = theme
  probe.hidden = true
  // Not inherited: a value that is not a colour computes to transparent.
  probe.style.backgroundColor = color
  document.body.append(probe)
  try {
    const computed = getComputedStyle(probe).backgroundColor
    const rgba = parseRgb(computed) ?? paint(computed)
    return rgba && rgba[3] > 0 ? rgbaToHex(rgba) : null
  } finally {
    probe.remove()
  }
}
