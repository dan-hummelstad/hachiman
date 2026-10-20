import {
  DEFAULT_LIMITS,
  PROFILE_IMAGE_TYPES,
  RestError,
  embedKind,
  type Limits
} from '@hachiman/client'
import {
  CryptoError,
  THUMBNAIL_MAX_EDGE,
  type AttachmentInput,
  type AttachmentPointer,
  type ThumbnailPointer
} from '@hachiman/crypto'
import { pointerOf } from '@/lib/attachments'
import { formatBytes } from '@/lib/format-bytes'
import { errMsg } from '@/lib/utils'
import { cryptoService } from '@/services/CryptoService'
import { hachiman } from '@/services/client'
import { useLimitsStore } from '@/stores/limitsStore'

const FORMAT_NAMES: Record<(typeof PROFILE_IMAGE_TYPES)[number], string> = {
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'image/gif': 'GIF',
  'image/webp': 'WebP'
}

/** "PNG, JPEG, GIF or WebP": the avatar, icon and banner formats, for hints and errors. */
export const PROFILE_IMAGE_FORMATS = PROFILE_IMAGE_TYPES.map((t) => FORMAT_NAMES[t])
  .join(', ')
  .replace(/, ([^,]*)$/, ' or $1')

let loadingLimits: Promise<void> | null = null

/** Fetch Takusen's upload limits once. A failure is logged and the next call tries again. */
export function ensureLimits(): void {
  if (loadingLimits || useLimitsStore.getState().limits) return
  loadingLimits = hachiman.rest
    .getLimits()
    .then((limits) => useLimitsStore.setState({ limits }))
    .catch((e) => console.warn('[limits] load failed', e))
    .finally(() => {
      loadingLimits = null
    })
}

/**
 * Takusen's upload limits, or the contract defaults until they load. Mount `ensureLimits` where an
 * upload can start, so they are usually loaded by the first check.
 */
export function currentLimits(): Limits {
  ensureLimits()
  return useLimitsStore.getState().limits ?? DEFAULT_LIMITS
}

/** Why `file` cannot be uploaded, or null if its size is fine. */
export function tooLarge(file: File): string | null {
  const limits = currentLimits()
  return file.size > limits.maxUploadBytes
    ? `${file.name} is larger than ${formatBytes(limits.maxUploadBytes)}.`
    : null
}

/**
 * A failed upload (or profile-image save) in words a user can act on. Server rejections with a
 * known code get their own line; anything else keeps its own message.
 */
export function uploadErrorText(e: unknown): string {
  if (e instanceof RestError && e.code === 'UploadTooLarge')
    return `The file is larger than ${formatBytes(currentLimits().maxUploadBytes)}.`
  if (e instanceof RestError && e.code === 'InvalidImage')
    return `Use a ${PROFILE_IMAGE_FORMATS} image.`
  if (e instanceof CryptoError && e.code === 'NotInitialized')
    return 'Encryption is not ready on this device yet.'
  return errMsg(e)
}

/** A failed claim of page media or a page banner in words a user can act on (413 StorageQuotaExceeded). */
export function claimErrorText(e: unknown): string {
  if (e instanceof RestError && e.code === 'StorageQuotaExceeded')
    return 'The page storage of this server is full.'
  return uploadErrorText(e)
}

/**
 * The log form of an attachment upload error: its kind and code only. A message can name the
 * file, and the file name is plaintext metadata that §12.9 keeps inside the envelope.
 */
function logShape(e: unknown): string {
  if (e instanceof RestError || e instanceof CryptoError) return `${e.name} ${e.code}`
  return e instanceof Error ? e.name : typeof e
}

export interface UploadFileOptions {
  signal?: AbortSignal | undefined
  /** 0..1 */
  onProgress?: ((fraction: number) => void) | undefined
}

/**
 * Upload one profile image (avatar, guild icon or banner). These stay plaintext (§12.1). Rejects
 * with an Error whose message is user-facing (see `uploadErrorText`), or with the AbortError when
 * `signal` aborts.
 */
export async function uploadFile(
  file: File,
  opts: UploadFileOptions = {}
): Promise<{ id: string; key: string; size: number }> {
  const { signal, onProgress } = opts
  const large = tooLarge(file)
  if (large) throw new Error(large)
  try {
    return await hachiman.rest.uploadImage(file, {
      filename: file.name || 'image',
      signal,
      onProgress: progress(onProgress)
    })
  } catch (e) {
    if (signal?.aborted) throw e
    console.warn('[uploads] profile image upload failed', e)
    throw new Error(uploadErrorText(e), { cause: e })
  }
}

/**
 * Encrypt one message attachment in the crypto Worker, then upload the file blob and the
 * thumbnail blob (§12.9). The server sees only the blob sizes: the name, MIME type and dimensions
 * are in the returned pointer, which goes into the envelope. Rejects like `uploadFile`.
 */
export async function uploadAttachment(
  file: File,
  opts: UploadFileOptions = {}
): Promise<AttachmentPointer> {
  const { signal, onProgress } = opts
  const large = tooLarge(file)
  if (large) throw new Error(large)
  try {
    const facts = await inspect(file, signal)
    if (signal?.aborted) throw abortError()
    const encrypted = await cryptoService.client().encryptAttachment({
      file,
      name: file.name || 'file',
      mime: file.type || 'application/octet-stream',
      width: facts.width,
      height: facts.height,
      durationMs: facts.durationMs,
      blurhash: null,
      thumbnail: facts.thumbnail
    })
    if (signal?.aborted) throw abortError()
    // TAKUSEN_MAX_UPLOAD_BYTES applies to the blob, which padding makes larger than the file.
    const max = currentLimits().maxUploadBytes
    if (encrypted.blob.size > max)
      throw new Error(`${file.name} is larger than ${formatBytes(max)} after encryption.`)
    const fileBytes = encrypted.blob.size
    const total = fileBytes + (encrypted.thumbnailBlob?.size ?? 0)
    const fileUpload = await hachiman.rest.uploadBlob(encrypted.blob, {
      signal,
      onProgress: (loaded) => onProgress?.(loaded / total)
    })
    const thumbUpload = encrypted.thumbnailBlob
      ? await hachiman.rest.uploadBlob(encrypted.thumbnailBlob, {
          signal,
          onProgress: (loaded) => onProgress?.((fileBytes + loaded) / total)
        })
      : null
    return pointerOf(encrypted.draft, fileUpload, thumbUpload)
  } catch (e) {
    if (signal?.aborted) throw e
    console.warn('[uploads] attachment upload failed', logShape(e))
    throw new Error(uploadErrorText(e), { cause: e })
  }
}

const LINK_IMAGE_MAX_EDGE = 640

/**
 * The image of a link preview (§12.8.1): decoded here, drawn again as WebP of at most
 * LINK_IMAGE_MAX_EDGE px (no metadata of the source survives), encrypted and uploaded as one blob.
 * Null when it does not decode.
 */
export async function uploadLinkImage(image: Blob): Promise<ThumbnailPointer | null> {
  const bitmap = await createImageBitmap(image).catch(() => null)
  if (!bitmap) return null
  let drawn: AttachmentInput['thumbnail']
  try {
    drawn = await drawThumbnail(bitmap, bitmap.width, bitmap.height, LINK_IMAGE_MAX_EDGE)
  } finally {
    bitmap.close()
  }
  if (!drawn) return null
  const encrypted = await cryptoService.client().encryptAttachment({
    file: drawn.blob,
    name: 'preview.webp',
    mime: drawn.mime,
    width: drawn.width,
    height: drawn.height,
    durationMs: null,
    blurhash: null,
    thumbnail: null
  })
  const upload = await hachiman.rest.uploadBlob(encrypted.blob)
  if (upload.size !== encrypted.draft.blobSize)
    throw new Error('The server stored a different file size.')
  const { key, sha256, size, blobSize, mime } = encrypted.draft
  return {
    uploadId: upload.id,
    key,
    sha256,
    size,
    blobSize,
    mime,
    width: drawn.width,
    height: drawn.height
  }
}

const progress =
  (onProgress: ((fraction: number) => void) | undefined) =>
  (loaded: number, total: number): void =>
    onProgress?.(total > 0 ? loaded / total : 0)

const abortError = (): DOMException => new DOMException('Upload aborted', 'AbortError')

interface FileFacts {
  width: number | null
  height: number | null
  durationMs: number | null
  thumbnail: AttachmentInput['thumbnail']
}

const NO_FACTS: FileFacts = { width: null, height: null, durationMs: null, thumbnail: null }

/** Longest reading a file's pixel size, duration and thumbnail may take. */
const INSPECT_TIMEOUT_MS = 3000

/**
 * Pixel size, duration and a thumbnail of at most THUMBNAIL_MAX_EDGE px, read locally. A file
 * that does not decode here (for example HEVC), takes too long, or an abort gives no facts: the
 * upload goes on without them.
 */
async function inspect(file: File, signal: AbortSignal | undefined): Promise<FileFacts> {
  const kind = embedKind(file.type)
  if (kind === 'file') return NO_FACTS
  const timeout = AbortSignal.timeout(INSPECT_TIMEOUT_MS)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  const stopped = new Promise<FileFacts>((resolve) => {
    if (stop.aborted) resolve(NO_FACTS)
    stop.addEventListener('abort', () => resolve(NO_FACTS), { once: true })
  })
  const read = (kind === 'image' ? imageFacts(file) : mediaFacts(file, kind, stop)).catch(
    () => NO_FACTS
  )
  return Promise.race([read, stopped])
}

/** The size that fits `width` × `height` into `maxEdge`, never larger than the source. */
export function thumbnailSize(
  width: number,
  height: number,
  maxEdge = THUMBNAIL_MAX_EDGE
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

async function drawThumbnail(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxEdge = THUMBNAIL_MAX_EDGE
): Promise<AttachmentInput['thumbnail']> {
  const size = thumbnailSize(width, height, maxEdge)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(source, 0, 0, size.width, size.height)
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.8)
  )
  return blob ? { blob, mime: blob.type || 'image/webp', ...size } : null
}

async function imageFacts(file: File): Promise<FileFacts> {
  const bitmap = await createImageBitmap(file)
  try {
    const { width, height } = bitmap
    const thumbnail = await drawThumbnail(bitmap, width, height).catch(() => null)
    return { width, height, durationMs: null, thumbnail }
  } finally {
    bitmap.close()
  }
}

function mediaFacts(file: File, kind: 'video' | 'audio', stop: AbortSignal): Promise<FileFacts> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const el = document.createElement(kind)
    const done = (facts: FileFacts): void => {
      el.onloadedmetadata = el.onseeked = el.onerror = null
      stop.removeEventListener('abort', giveUp)
      el.removeAttribute('src')
      el.load()
      URL.revokeObjectURL(url)
      resolve(facts)
    }
    const giveUp = (): void => done(NO_FACTS)
    if (stop.aborted) return giveUp()
    stop.addEventListener('abort', giveUp, { once: true })
    el.preload = 'metadata'
    el.muted = true
    el.onerror = giveUp
    el.onloadedmetadata = () => {
      const durationMs = Number.isFinite(el.duration) ? Math.round(el.duration * 1000) : null
      if (!(el instanceof HTMLVideoElement) || !el.videoWidth)
        return done({ ...NO_FACTS, durationMs })
      const { videoWidth: width, videoHeight: height } = el
      el.onseeked = () =>
        void drawThumbnail(el, width, height)
          .catch(() => null)
          .then((thumbnail) => done({ width, height, durationMs, thumbnail }))
      // A frame past 0: some encoders leave the first one black.
      el.currentTime = Math.min(0.1, el.duration || 0)
    }
    el.src = url
  })
}
