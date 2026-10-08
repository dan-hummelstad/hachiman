// Preview images: fixture file keys resolve to generated SVG data URLs, and files "uploaded" in
// preview resolve to object URLs, so avatars, icons and banners render without Takusen.
import { attachmentUrl } from './attachments'

/** File keys the fixture uses; the `preview/` prefix never collides with a real `{uploadId}/…` key. */
export const IMG = {
  nightOwlsIcon: 'preview/night-owls-icon.svg',
  nightOwlsBanner: 'preview/night-owls-banner.svg',
  latticeIcon: 'preview/lattice-icon.svg',
  emojiOwl: 'preview/emoji-owl.svg',
  emojiGg: 'preview/emoji-gg.svg'
} as const

export const avatarKey = (username: string): string => `preview/avatar-${username}.svg`

const svg = (w: number, h: number, body: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges">${body}</svg>`
  )}`

function hash(s: string): number {
  let h = 2166136261
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return h >>> 0
}

const AVATAR_COLORS = ['#f0b429', '#3fb950', '#58a6ff', '#e5534b', '#bc8cff', '#2f9e8f']

/** A mirrored 5x5 identicon, the old-messenger buddy-icon look. */
function identicon(seed: string): string {
  const h = hash(seed)
  const fg = AVATAR_COLORS[h % AVATAR_COLORS.length]
  let cells = ''
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++) {
      if (!((h >>> (y * 3 + x + 3)) & 1)) continue
      for (const cx of new Set([x, 4 - x]))
        cells += `<rect x="${cx + 1}" y="${y + 1}" width="1" height="1"/>`
    }
  return svg(7, 7, `<rect width="7" height="7" fill="#1c1f25"/><g fill="${fg}">${cells}</g>`)
}

const STARS = [
  [22, 14],
  [61, 30],
  [98, 10],
  [140, 24],
  [176, 8],
  [205, 36],
  [118, 44],
  [40, 48]
]

const STATIC: Record<string, string> = {
  [IMG.nightOwlsIcon]: svg(
    10,
    10,
    '<rect width="10" height="10" fill="#1b2340"/><circle cx="6.2" cy="3.8" r="2.4" fill="#f0b429"/><circle cx="7.2" cy="3.1" r="2" fill="#1b2340"/><rect x="1" y="7" width="8" height="1" fill="#2f3a63"/>'
  ),
  [IMG.nightOwlsBanner]: svg(
    240,
    135,
    `<rect width="240" height="135" fill="#141a33"/><rect y="70" width="240" height="65" fill="#1b2340"/>` +
      STARS.map(([x, y]) => `<rect x="${x}" y="${y}" width="2" height="2" fill="#e6e8ec"/>`).join(
        ''
      ) +
      `<circle cx="186" cy="52" r="20" fill="#f0b429"/><circle cx="196" cy="45" r="17" fill="#141a33"/>` +
      `<path d="M0 135V96l30-14 26 10 34-22 40 20 30-12 40 16 40-8v49z" fill="#0d1124"/>`
  ),
  [IMG.emojiOwl]: svg(
    8,
    8,
    '<rect x="1" y="1" width="6" height="6" fill="#8a5a2b"/><rect x="2" y="2" width="2" height="2" fill="#f0b429"/><rect x="4" y="2" width="2" height="2" fill="#f0b429"/><rect x="3" y="4" width="2" height="1" fill="#e5534b"/>'
  ),
  [IMG.emojiGg]: svg(
    8,
    8,
    '<rect width="8" height="8" rx="1" fill="#3fb950"/><rect x="1" y="2" width="2" height="4" fill="#fff"/><rect x="5" y="2" width="2" height="4" fill="#fff"/>'
  ),
  [IMG.latticeIcon]: svg(
    10,
    10,
    '<rect width="10" height="10" fill="#e9ecf0"/><g fill="#2f9e8f"><rect x="2" y="2" width="2" height="2"/><rect x="6" y="2" width="2" height="2"/><rect x="2" y="6" width="2" height="2"/><rect x="6" y="6" width="2" height="2"/></g><g fill="#c98a0b"><rect x="4" y="4" width="2" height="2"/></g>'
  )
}

/** Keys of files uploaded in this preview session → their object URLs. */
export const uploaded = new Map<string, string>()

/** Preview stand-in for `RestClient.fileUrl`. */
export function previewFileUrl(key: string): string {
  if (STATIC[key]) return STATIC[key]
  if (key.startsWith('preview/avatar-')) return identicon(key)
  return attachmentUrl(key) ?? uploaded.get(key) ?? key
}
