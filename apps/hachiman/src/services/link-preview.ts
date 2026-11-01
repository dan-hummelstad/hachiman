import { parseLinkPage } from '@/lib/link-preview'
import { hostPlatform } from '@/services/hachiman'
import type { IPlatformService } from '@/shared/IPlatformService'

type Fetch = NonNullable<IPlatformService['fetchLinkResource']>

/** The preview of a link that this device made when the message came into view (§12.8.1). */
export interface ViewedLinkPreview {
  url: string
  title: string
  description: string
  siteName: string
  /** An object URL of the fetched image bytes, or null. */
  image: string | null
}

/**
 * The cap of each fetch. The parser reads the whole head: YouTube puts its meta tags after about
 * 770 KB of inline script.
 */
const FETCH_MAX_BYTES = 5 * 1024 * 1024
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])
/** No SVG: it can carry script. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const CACHE_MAX = 200

/** One fetch per URL per run: every message with the same link shares it. */
// ponytail: an evicted entry revokes its image while a card may still show it; past CACHE_MAX links in one session an old card can lose its image.
const cache = new Map<string, Promise<ViewedLinkPreview | null>>()

/**
 * The preview of `url`, fetched by this device through the host (no cookies), or null: the host
 * cannot fetch (browser), or the page gives nothing. Never rejects.
 */
export function loadLinkPreview(url: string): Promise<ViewedLinkPreview | null> {
  const fetchResource = hostPlatform()?.fetchLinkResource
  if (!fetchResource) return Promise.resolve(null)
  const known = cache.get(url)
  if (known) return known
  const built = buildLinkPreview(url, fetchResource).catch((e: unknown) => {
    // The name only: the URL is message content.
    console.warn('[link-preview] failed', e instanceof Error ? e.name : typeof e)
    return null
  })
  cache.set(url, built)
  if (cache.size > CACHE_MAX) {
    const [oldest, entry] = cache.entries().next().value!
    cache.delete(oldest)
    void entry.then((p) => p?.image && URL.revokeObjectURL(p.image))
  }
  return built
}

async function buildLinkPreview(
  url: string,
  fetchResource: Fetch
): Promise<ViewedLinkPreview | null> {
  const res = await fetchResource(url, FETCH_MAX_BYTES)
  if (!res) return null
  // A link straight to an image: the preview is the image alone (the card shows it embedded).
  if (IMAGE_TYPES.has(res.contentType))
    return { url, title: '', description: '', siteName: '', image: objectUrl(res) }
  if (!HTML_TYPES.has(res.contentType)) return null
  // ponytail: UTF-8 only; a page in another charset shows mangled text.
  const info = parseLinkPage(new TextDecoder().decode(res.body), res.url)
  if (!info) return null
  const image = info.imageUrl ? await fetchResource(info.imageUrl, FETCH_MAX_BYTES) : null
  return {
    url,
    title: info.title,
    description: info.description,
    siteName: info.siteName,
    image: image && IMAGE_TYPES.has(image.contentType) ? objectUrl(image) : null
  }
}

const objectUrl = (res: { body: Uint8Array<ArrayBuffer>; contentType: string }): string =>
  URL.createObjectURL(new Blob([res.body], { type: res.contentType }))
