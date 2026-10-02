import * as Y from 'yjs'
import type { AttachmentPointer, ThumbnailPointer } from '@hachiman/crypto'
import { uploadIdsOf } from '@/lib/attachments'

/** The ProseMirror (and Y.XmlElement) name of a media node in a page. */
export const MEDIA_NODE = 'hm_media'

/** The fragment that @milkdown/plugin-collab binds. */
const FRAGMENT = 'prosemirror'

// Shape checks only: the crypto Worker checks the key and hash lengths when it decrypts, and
// fails closed. (The ?preview stubs use short ids and empty keys.)
const UPLOAD_ID = /^[A-Za-z0-9-]{1,64}$/
const B64URL = /^[A-Za-z0-9_-]{0,64}$/
const MAX_TEXT = 1024

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isSize = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const isDim = (v: unknown): boolean => v === null || (isSize(v) && v > 0)
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT
const isBlobRef = (v: Record<string, unknown>): boolean =>
  typeof v.uploadId === 'string' &&
  UPLOAD_ID.test(v.uploadId) &&
  typeof v.key === 'string' &&
  B64URL.test(v.key) &&
  typeof v.sha256 === 'string' &&
  B64URL.test(v.sha256) &&
  isSize(v.size) &&
  isSize(v.blobSize) &&
  isText(v.mime)

function parseThumbnail(v: unknown): ThumbnailPointer | null | undefined {
  if (v === null) return null
  if (!isRecord(v) || !isBlobRef(v) || !isSize(v.width) || !isSize(v.height)) return undefined
  const { uploadId, key, sha256, size, blobSize, mime, width, height } = v
  return { uploadId, key, sha256, size, blobSize, mime, width, height } as ThumbnailPointer
}

/**
 * The attachment pointer in the `pointer` attribute of a media node, or null when it is not one.
 * Any member who can edit the page writes these attributes, so every field is checked, and only
 * the known fields are kept.
 */
export function parsePointer(json: unknown): AttachmentPointer | null {
  if (typeof json !== 'string' || json.length > 8192) return null
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(v) || !isBlobRef(v) || !isText(v.name)) return null
  if (!isDim(v.width) || !isDim(v.height)) return null
  if (v.durationMs !== null && !isSize(v.durationMs)) return null
  if (v.blurhash !== null && !isText(v.blurhash)) return null
  const thumbnail = parseThumbnail(v.thumbnail)
  if (thumbnail === undefined) return null
  const { uploadId, key, sha256, size, blobSize, mime, name, width, height, durationMs, blurhash } =
    v
  return {
    uploadId,
    key,
    sha256,
    size,
    blobSize,
    mime,
    name,
    width,
    height,
    durationMs,
    blurhash,
    thumbnail
  } as AttachmentPointer
}

/** The page_media upload ids (files and thumbnails) that the media nodes of `doc` reference. */
export function collectMediaUploadIds(doc: Y.Doc): string[] {
  const ids = new Set<string>()
  const walk = (parent: Y.XmlFragment | Y.XmlElement): void => {
    for (const child of parent.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue
      if (child.nodeName === MEDIA_NODE) {
        const pointer = parsePointer(child.getAttribute('pointer'))
        if (pointer) for (const id of uploadIdsOf([pointer])) ids.add(id)
      }
      walk(child)
    }
  }
  walk(doc.getXmlFragment(FRAGMENT))
  return [...ids]
}
