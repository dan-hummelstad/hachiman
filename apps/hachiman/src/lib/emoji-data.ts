/**
 * The Unicode emoji set of the picker and the `:shortcode` completion, from emojibase-data
 * (English labels, iamcal shortcodes: the Slack and Discord names). The data is about 600 KB, so it
 * loads on first use as its own chunk.
 */

/** One Unicode emoji. `skins` holds the 5 skin tone variants, light to dark. */
export interface UnicodeEmoji {
  emoji: string
  /** "grinning face" */
  label: string
  /** Without colons: ["grinning"]. The first one is the main name. */
  shortcodes: string[]
  tags: string[]
  /** Index into EMOJI_GROUPS. */
  group: number
  skins?: string[]
}

export interface EmojiGroup {
  id: string
  label: string
  /** The emoji of the category tab. */
  icon: string
}

/** The picker categories, in emojibase group order. The "component" group (skin tones) is left out. */
export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  { id: 'smileys-emotion', label: 'Smileys & emotion', icon: '😀' },
  { id: 'people-body', label: 'People & body', icon: '👋' },
  { id: 'animals-nature', label: 'Animals & nature', icon: '🐻' },
  { id: 'food-drink', label: 'Food & drink', icon: '🍔' },
  { id: 'travel-places', label: 'Travel & places', icon: '✈️' },
  { id: 'activities', label: 'Activities', icon: '⚽' },
  { id: 'objects', label: 'Objects', icon: '💡' },
  { id: 'symbols', label: 'Symbols', icon: '❤️' },
  { id: 'flags', label: 'Flags', icon: '🏁' }
]

/** emojibase group number → index into EMOJI_GROUPS (group 2, the components, has none). */
const GROUP_INDEX: Record<number, number> = { 0: 0, 1: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8 }

/** The skin tones of the picker: 0 is the default (yellow), 1 to 5 light to dark. */
export const SKIN_TONES: readonly { label: string; swatch: string }[] = [
  { label: 'Default', swatch: '✋' },
  { label: 'Light', swatch: '✋🏻' },
  { label: 'Medium-light', swatch: '✋🏼' },
  { label: 'Medium', swatch: '✋🏽' },
  { label: 'Medium-dark', swatch: '✋🏾' },
  { label: 'Dark', swatch: '✋🏿' }
]

export interface EmojiData {
  /** In emojibase order. */
  emojis: UnicodeEmoji[]
  /** Every emoji and skin variant → its base entry. */
  byEmoji: Map<string, UnicodeEmoji>
  /** Shortcode (no colons) → its emoji. */
  byShortcode: Map<string, UnicodeEmoji>
}

interface RawEmoji {
  hexcode: string
  label: string
  unicode: string
  group?: number
  tags?: string[]
  skins?: { unicode: string }[]
}

/**
 * Builds the lookup tables from the emojibase files. `unsupported`: the hexcodes that this device
 * cannot draw, left out. Exported for tests.
 */
export function buildEmojiData(
  raw: readonly RawEmoji[],
  shortcodes: Record<string, string | string[]>,
  unsupported: ReadonlySet<string> = new Set()
): EmojiData {
  const emojis: UnicodeEmoji[] = []
  const byEmoji = new Map<string, UnicodeEmoji>()
  const byShortcode = new Map<string, UnicodeEmoji>()
  for (const r of raw) {
    const group = r.group === undefined ? undefined : GROUP_INDEX[r.group]
    if (group === undefined || unsupported.has(r.hexcode)) continue
    const sc = shortcodes[r.hexcode]
    const e: UnicodeEmoji = {
      emoji: r.unicode,
      label: r.label,
      shortcodes: sc === undefined ? [] : Array.isArray(sc) ? sc : [sc],
      tags: r.tags ?? [],
      group,
      ...(r.skins && r.skins.length === 5 ? { skins: r.skins.map((s) => s.unicode) } : {})
    }
    emojis.push(e)
    byEmoji.set(e.emoji, e)
    for (const s of e.skins ?? []) byEmoji.set(s, e)
    for (const s of e.shortcodes) if (!byShortcode.has(s)) byShortcode.set(s, e)
  }
  return { emojis, byEmoji, byShortcode }
}

/**
 * One single-codepoint emoji of each newer Emoji version, oldest first. The newest version whose
 * probe draws in colour is the newest that this device's emoji font has.
 */
const VERSION_PROBES: readonly (readonly [version: number, emoji: string])[] = [
  [13, '\u{1F972}'], // smiling face with tear
  [14, '\u{1FAE0}'], // melting face
  [15, '\u{1FAE8}'], // shaking face
  [16, '\u{1FAE9}'], // face with bags under eyes
  [17, '\u{1FAEA}'] // distorted face
]

/** True when `emoji` draws with colour (a glyph of the emoji font), false for a grey empty box. */
function drawsInColour(ctx: OffscreenCanvasRenderingContext2D, emoji: string): boolean {
  ctx.clearRect(0, 0, 20, 20)
  ctx.fillText(emoji, 0, 0)
  const px = ctx.getImageData(0, 0, 20, 20).data
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] > 0 && (px[i] !== px[i + 1] || px[i + 1] !== px[i + 2])) return true
  }
  return false
}

/** An Emoji 1.0 face that every emoji font has: the control for the probes. */
const BASELINE_PROBE = '\u{1F600}'

/**
 * The newest probed version that `draws`, from 12.1 up. Null when even the baseline does not draw:
 * then the readback is blank or a placeholder (a privacy-hardened canvas), not a missing font.
 */
export function newestFromProbes(draws: (emoji: string) => boolean): number | null {
  if (!draws(BASELINE_PROBE)) return null
  let newest = 12.1
  for (const [version, emoji] of VERSION_PROBES) {
    if (!draws(emoji)) break
    newest = version
  }
  return newest
}

/**
 * The newest Emoji version that this device draws, or null when it cannot be measured (no
 * OffscreenCanvas, as in tests, or no usable readback): then the picker keeps every emoji. iOS 18.5
 * has Emoji 16, not 17, so the Emoji 17 characters would show as empty boxes.
 */
function newestDrawnVersion(): number | null {
  if (typeof OffscreenCanvas === 'undefined') return null
  try {
    const ctx = new OffscreenCanvas(20, 20).getContext('2d', { willReadFrequently: true })
    if (!ctx) return null
    ctx.font = '16px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif'
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#000'
    return newestFromProbes((emoji) => drawsInColour(ctx, emoji))
  } catch {
    return null
  }
}

/** The hexcodes of the Emoji versions after `newest`. 15.1 counts as newer than 15. */
function hexcodesAfter(byVersion: Record<string, string[]>, newest: number): Set<string> {
  const out = new Set<string>()
  for (const [version, hexcodes] of Object.entries(byVersion)) {
    if (Number(version) > newest) for (const h of hexcodes) out.add(h)
  }
  return out
}

let loading: Promise<EmojiData> | null = null
let loaded: EmojiData | null = null

/** The emoji data, loaded once. A failed load is tried again on the next call. */
export function loadEmojiData(): Promise<EmojiData> {
  loading ??= Promise.all([
    import('emojibase-data/en/compact.json'),
    import('emojibase-data/en/shortcodes/iamcal.json'),
    import('emojibase-data/versions/emoji.json')
  ]).then(
    ([compact, iamcal, versions]) => {
      const newest = newestDrawnVersion()
      loaded = buildEmojiData(
        compact.default as unknown as RawEmoji[],
        iamcal.default as unknown as Record<string, string | string[]>,
        newest === null
          ? undefined
          : hexcodesAfter(versions.default as unknown as Record<string, string[]>, newest)
      )
      return loaded
    },
    (err: unknown) => {
      loading = null
      throw err
    }
  )
  return loading
}

/** The data if it has loaded, else null (no load starts). */
export const emojiDataNow = (): EmojiData | null => loaded

/** The emoji in skin tone `tone` (0 = default), or the emoji itself when it has no tones. */
export function withSkin(e: UnicodeEmoji, tone: number): string {
  return tone > 0 && e.skins ? (e.skins[tone - 1] ?? e.emoji) : e.emoji
}

/**
 * Typed `:shortcode:`s of Unicode emojis → the emojis, as Discord does on send. Custom emoji wire
 * forms (`<:name:id>`) and unknown codes stay as they are.
 */
export function replaceShortcodes(text: string, data: EmojiData, tone = 0): string {
  return text.replace(/<a?:\w{2,32}:[\w-]+>|:([\w+-]{2,32}):/g, (all, code: string | undefined) => {
    const e = code === undefined ? undefined : data.byShortcode.get(code.toLowerCase())
    return e ? withSkin(e, tone) : all
  })
}

/** 0 shortcode prefix, 1 label word or tag prefix, 2 contains, -1 no match. `query` is lowercase. */
function rank(e: UnicodeEmoji, query: string): number {
  if (e.shortcodes.some((s) => s.startsWith(query))) return 0
  const words = [...e.label.split(/[\s:,-]+/), ...e.tags]
  if (words.some((w) => w.startsWith(query))) return 1
  if (e.shortcodes.some((s) => s.includes(query)) || e.label.includes(query)) return 2
  return -1
}

/** The emojis that match `query` (name, shortcode or tag), best match first. */
export function searchEmoji(data: EmojiData, query: string, limit = 80): UnicodeEmoji[] {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/^:|:$/g, '')
    .replace(/[\s_]+/g, '_')
  if (!q) return []
  const plain = q.replace(/_/g, ' ')
  const scored: { e: UnicodeEmoji; r: number; i: number }[] = []
  data.emojis.forEach((e, i) => {
    const r = Math.min(...[rank(e, q), rank(e, plain)].map((x) => (x < 0 ? 9 : x)))
    if (r < 9) scored.push({ e, r, i })
  })
  scored.sort((a, b) => a.r - b.r || a.i - b.i)
  return scored.slice(0, limit).map((s) => s.e)
}
