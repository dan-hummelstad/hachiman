import type { LinkPreview, ThumbnailPointer } from '@hachiman/crypto'
import { parseLinkPage } from '@/lib/link-preview'
import type { IPlatformService } from '@/shared/IPlatformService'
import { uploadLinkImage } from './UploadService'

type Fetch = NonNullable<IPlatformService['fetchLinkResource']>

/** Bytes of a page that the parser reads. The head comes first, so this is ample. */
const PAGE_MAX_BYTES = 512 * 1024
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])
/** No SVG: it can carry script, and the preview redraws only bitmaps. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * The sender-made preview of `url` (§12.8.1): the host fetches the page and its image, this
 * device reads them, and the image goes up as an encrypted blob. Receivers never fetch. Null when
 * the page is not HTML or names nothing. `withImage` false: the message has no upload id left.
 */
export async function buildLinkPreview(
  url: string,
  fetchResource: Fetch,
  withImage: boolean
): Promise<LinkPreview | null> {
  const page = await fetchResource(url, PAGE_MAX_BYTES)
  if (!page || !HTML_TYPES.has(page.contentType)) return null
  // ponytail: UTF-8 only; a page in another charset shows mangled text.
  const info = parseLinkPage(new TextDecoder().decode(page.body), page.url)
  if (!info) return null
  const image =
    withImage && info.imageUrl
      ? await linkImage(info.imageUrl, fetchResource).catch(() => null)
      : null
  return { url, title: info.title, description: info.description, siteName: info.siteName, image }
}

async function linkImage(url: string, fetchResource: Fetch): Promise<ThumbnailPointer | null> {
  const res = await fetchResource(url, IMAGE_MAX_BYTES)
  if (!res || !IMAGE_TYPES.has(res.contentType)) return null
  return uploadLinkImage(new Blob([res.body], { type: res.contentType }))
}
