import {
  MAX_MESSAGE_UPLOAD_IDS,
  type AttachmentPointer,
  type LinkPreview,
  type ThumbnailPointer
} from '@hachiman/crypto'
import { uploadIdsOf } from '@/lib/attachments'
import { parseLinkPage, previewUrlOf } from '@/lib/link-preview'
import { hostPlatform } from '@/services/hachiman'
import { takusenService } from '@/services/TakusenService'
import type { IPlatformService } from '@/shared/IPlatformService'
import { usePrefsStore } from '@/stores/prefsStore'
import { uploadLinkImage } from './UploadService'

type Fetch = NonNullable<IPlatformService['fetchLinkResource']>

/** Longest a send waits for its link preview; then it goes without one. */
const BUDGET_MS = 8_000
/** Bytes of a page that the parser reads. The head comes first, so this is ample. */
const PAGE_MAX_BYTES = 512 * 1024
const IMAGE_MAX_BYTES = 5 * 1024 * 1024
const HTML_TYPES = new Set(['text/html', 'application/xhtml+xml'])
/** No SVG: it can carry script, and the preview redraws only bitmaps. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * The link preview of a message that this device sends (§12.8.1), or null: the setting is off,
 * the host cannot fetch, the text has no https link, or the page gives nothing within BUDGET_MS.
 * Never rejects, so it never fails the send. Receivers never fetch.
 */
export async function linkPreviewFor(
  text: string,
  attachments: readonly AttachmentPointer[]
): Promise<LinkPreview | null> {
  const fetchResource = hostPlatform()?.fetchLinkResource
  if (!fetchResource || !usePrefsStore.getState().linkPreviews) return null
  const url = previewUrlOf(text, takusenService.env.issuerOrigin)
  if (!url) return null
  // A message of MAX_MESSAGE_UPLOAD_IDS uploads has no id left for the image.
  const withImage = uploadIdsOf(attachments).length < MAX_MESSAGE_UPLOAD_IDS
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), BUDGET_MS)))
  const built = buildLinkPreview(url, fetchResource, withImage).catch((e: unknown) => {
    // The name only: the URL is message content.
    console.warn('[link-preview] failed', e instanceof Error ? e.name : typeof e)
    return null
  })
  return Promise.race([built, late]).finally(() => clearTimeout(timer))
}

async function buildLinkPreview(
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
