import {
  DEFAULT_LIMITS,
  PROFILE_IMAGE_TYPES,
  RestError,
  embedKind,
  type Attachment,
  type Limits
} from '@hachiman/client'
import { formatBytes } from '@/lib/format-bytes'
import { errMsg } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
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
  return errMsg(e)
}

export interface UploadFileOptions {
  signal?: AbortSignal | undefined
  /** 0..1 */
  onProgress?: ((fraction: number) => void) | undefined
}

/**
 * Upload one file to Takusen with its pixel size. Rejects with an Error whose message is
 * user-facing (see `uploadErrorText`), or with the AbortError when `signal` aborts.
 */
export async function uploadFile(file: File, opts: UploadFileOptions = {}): Promise<Attachment> {
  const { signal, onProgress } = opts
  const large = tooLarge(file)
  if (large) throw new Error(large)
  try {
    const size = await measure(file, signal)
    return await hachiman.rest.upload(file, {
      filename: file.name || 'file',
      ...size,
      signal,
      onProgress: onProgress && ((loaded, total) => onProgress(total > 0 ? loaded / total : 0))
    })
  } catch (e) {
    if (signal?.aborted) throw e
    console.warn('[uploads] %s failed', file.name, e)
    throw new Error(uploadErrorText(e), { cause: e })
  }
}

type Size = { width?: number; height?: number }

/** Longest reading a file's pixel size may take before it uploads without one. */
const MEASURE_TIMEOUT_MS = 3000

/**
 * Pixel size for layout, read locally. Undecodable here (e.g. HEVC), too slow, or aborted just
 * uploads without it.
 */
async function measure(file: File, signal: AbortSignal | undefined): Promise<Size> {
  const kind = embedKind(file.type)
  if (kind !== 'image' && kind !== 'video') return {}
  const timeout = AbortSignal.timeout(MEASURE_TIMEOUT_MS)
  const stop = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    return await (kind === 'image' ? imageSize(file, stop) : videoSize(file, stop))
  } catch {
    return {}
  }
}

function imageSize(file: File, stop: AbortSignal): Promise<Size> {
  const read = createImageBitmap(file).then((bitmap) => {
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  })
  const stopped = new Promise<Size>((resolve) => {
    if (stop.aborted) resolve({})
    stop.addEventListener('abort', () => resolve({}), { once: true })
  })
  return Promise.race([read, stopped])
}

function videoSize(file: File, stop: AbortSignal): Promise<Size> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    const done = (size: Size): void => {
      video.onloadedmetadata = video.onerror = null
      stop.removeEventListener('abort', giveUp)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
      resolve(size)
    }
    const giveUp = (): void => done({})
    if (stop.aborted) return giveUp()
    stop.addEventListener('abort', giveUp, { once: true })
    video.preload = 'metadata'
    video.muted = true
    video.onloadedmetadata = () =>
      done(video.videoWidth ? { width: video.videoWidth, height: video.videoHeight } : {})
    video.onerror = giveUp
    video.src = url
  })
}
