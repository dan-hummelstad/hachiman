/**
 * The banner of a top-level page (contract §12.20 doc_banner): the attachment pointer of an
 * encrypted image, in a row envelope next to the title. Any member who can edit the page writes
 * it, so the UI checks it fully and fails closed: a banner that does not pass is no banner.
 */
import {
  ATTACHMENT_HEADER_LENGTH,
  ATTACHMENT_SEGMENT_SIZE,
  ATTACHMENT_TAG_LENGTH,
  type AttachmentPointer,
  type ThumbnailPointer
} from '@hachiman/crypto'
import { parsePointer } from './media'

/** The largest banner file (plaintext) that a pointer may name. */
export const BANNER_MAX_BYTES = 8 * 1024 * 1024

// Padmé (§12.9) of size + 1 for a size up to 8 MiB: at most 1/32 more, rounded to 2^18.
const BANNER_MAX_PADDED = BANNER_MAX_BYTES + BANNER_MAX_BYTES / 32

/**
 * The largest encrypted blob (§12.9) of a banner: the header, the padded file and a tag per
 * segment. The pointer's blobSize is the download cap (useDecryptedBlob gives it to fetchBlob as
 * maxBytes), so a pointer cannot force a large download.
 */
export const BANNER_MAX_BLOB_BYTES =
  ATTACHMENT_HEADER_LENGTH +
  BANNER_MAX_PADDED +
  ATTACHMENT_TAG_LENGTH * Math.ceil(BANNER_MAX_PADDED / ATTACHMENT_SEGMENT_SIZE)

/** The image types of a banner. No SVG. */
export const BANNER_MIMES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
]

const fromUtf8 = new TextDecoder('utf-8', { fatal: true })

const isBannerImage = (p: Pick<ThumbnailPointer, 'mime' | 'size' | 'blobSize'>): boolean =>
  BANNER_MIMES.includes(p.mime) &&
  p.size <= BANNER_MAX_BYTES &&
  p.blobSize >= p.size &&
  p.blobSize <= BANNER_MAX_BLOB_BYTES

/** The pointer of a decrypted doc_banner body, or null when it is not a banner image. */
export function parseBanner(bytes: Uint8Array): AttachmentPointer | null {
  let json: string
  try {
    json = fromUtf8.decode(bytes)
  } catch {
    return null
  }
  const p = parsePointer(json)
  if (!p || !isBannerImage(p) || p.width === null || p.height === null) return null
  if (p.thumbnail !== null && !isBannerImage(p.thumbnail)) return null
  return p
}
