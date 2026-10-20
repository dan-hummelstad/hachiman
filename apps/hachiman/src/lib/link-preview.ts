import {
  type LinkPreview,
  MAX_LINK_PREVIEW_DESCRIPTION_BYTES,
  MAX_LINK_PREVIEW_SITE_NAME_BYTES,
  MAX_LINK_PREVIEW_TITLE_BYTES,
  MAX_LINK_PREVIEW_URL_BYTES
} from '@hachiman/crypto'
import { tokenize } from './mentions'

/**
 * The link of a message text that gets a preview (§12.8.1 LinkPreview): the first https link, not
 * one of `skipOrigin` (Takusen: an invite link has its own card), at most the URL limit.
 */
export function previewUrlOf(text: string, skipOrigin: string | null): string | null {
  for (const t of tokenize(text)) {
    if (t.kind !== 'link') continue
    let url: URL
    try {
      url = new URL(t.value)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || url.origin === skipOrigin) continue
    if (utf8Length(t.value) > MAX_LINK_PREVIEW_URL_BYTES) continue
    return t.value
  }
  return null
}

/** What a page says about itself: OpenGraph, then Twitter, then plain HTML. */
export interface LinkPage {
  title: string
  description: string
  siteName: string
  /** An absolute https URL, or null. */
  imageUrl: string | null
}

/**
 * Reads the `<meta>` tags and the `<title>` of an HTML page. `pageUrl` is the final URL after
 * redirects: a relative image URL resolves against it. Null when the page names nothing.
 * ponytail: regexes over the head, not a DOM parser (none in the node tests); a page that hides
 * its tags in odd markup gets no preview.
 */
export function parseLinkPage(html: string, pageUrl: string): LinkPage | null {
  const bodyAt = html.search(/<body[\s>]/i)
  const head = bodyAt > 0 ? html.slice(0, bodyAt) : html
  const meta = new Map<string, string>()
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributesOf(tag)
    const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase()
    const content = attrs.get('content')
    if (key && content !== undefined && !meta.has(key)) meta.set(key, content)
  }
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  const pick = (...keys: string[]): string =>
    keys.map((k) => meta.get(k)).find((v) => v !== undefined && v.trim() !== '') ?? ''

  const title = clip(
    pick('og:title', 'twitter:title') || decodeEntities(titleTag ?? ''),
    MAX_LINK_PREVIEW_TITLE_BYTES
  )
  const description = clip(
    pick('og:description', 'twitter:description', 'description'),
    MAX_LINK_PREVIEW_DESCRIPTION_BYTES
  )
  const siteName = clip(pick('og:site_name', 'application-name'), MAX_LINK_PREVIEW_SITE_NAME_BYTES)
  const imageUrl = httpsUrl(
    pick('og:image:secure_url', 'og:image', 'og:image:url', 'twitter:image'),
    pageUrl
  )
  if (!title && !description && !imageUrl) return null
  return { title, description, siteName, imageUrl }
}

/** Attribute name → decoded value of one tag. */
function attributesOf(tag: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of tag.matchAll(
    /([a-zA-Z_:][-\w:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g
  )) {
    out.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ''))
  }
  return out
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? whole
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)
      ? String.fromCodePoint(code)
      : whole
  })
}

function httpsUrl(raw: string, base: string): string | null {
  if (!raw) return null
  try {
    const url = new URL(raw.trim(), base)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

const encoder = new TextEncoder()
const utf8Length = (s: string): number => encoder.encode(s).length

/** One line of text, cut to `maxBytes` UTF-8 bytes on a code point, with an ellipsis when cut. */
export function clip(raw: string, maxBytes: number): string {
  const s = raw.replace(/[\p{Cc}\s]+/gu, ' ').trim()
  if (utf8Length(s) <= maxBytes) return s
  let out = ''
  // Each code unit is at least one byte, so a longer prefix never fits.
  for (const ch of s.slice(0, maxBytes)) {
    if (utf8Length(out + ch + '…') > maxBytes) break
    out += ch
  }
  return out + '…'
}

/** A preview card shows while the text still has its link: an edit that removes it hides the card. */
export const showsLinkPreview = (
  text: string,
  preview: LinkPreview | null
): preview is LinkPreview => preview !== null && text.includes(preview.url)
