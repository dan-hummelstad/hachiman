/**
 * A page banner image as it is uploaded (plan "Decisions" 6): scaled down to at most
 * BANNER_MAX_WIDTH px wide and encoded again as WebP, or as JPEG where the browser has no WebP
 * encoder (WebKit). The new encode drops EXIF and GPS data, which every member could otherwise
 * read, and the file name of the original. An animated GIF keeps only its first frame.
 */

export const BANNER_MAX_WIDTH = 2048
export const BANNER_QUALITY = 0.85

/** The size that fits `width` × `height` into BANNER_MAX_WIDTH, never larger than the source. */
export function bannerSize(width: number, height: number): { width: number; height: number } {
  if (width <= BANNER_MAX_WIDTH) return { width, height }
  return {
    width: BANNER_MAX_WIDTH,
    height: Math.max(1, Math.round((height * BANNER_MAX_WIDTH) / width))
  }
}

/**
 * The type to encode again as, after a WebP request gave `type`: null keeps the blob. A browser
 * without a WebP encoder gives PNG, which is too large for a photo, so JPEG follows.
 */
export const fallbackType = (type: string): 'image/jpeg' | null =>
  type === 'image/webp' || type === 'image/jpeg' ? null : 'image/jpeg'

/**
 * The fill under the image for an encode as `type`, or null to keep the alpha. JPEG has no alpha:
 * the canvas would put black under a transparent PNG, GIF or WebP (a logo), so white goes first.
 */
export const opaqueFill = (type: string): string | null => (type === 'image/jpeg' ? '#fff' : null)

/** The file name of an encoded banner. The original name never reaches the pointer. */
export const bannerFileName = (type: string): string =>
  type === 'image/webp' ? 'banner.webp' : 'banner.jpg'

const encode = (canvas: HTMLCanvasElement, type: string): Promise<Blob> =>
  new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('The image could not be encoded.'))),
      type,
      BANNER_QUALITY
    )
  )

/** Decodes `file` (with its EXIF rotation), scales it and encodes it again. */
export async function prepareBannerImage(file: File): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/svg+xml')
    throw new Error('Choose a PNG, JPEG, GIF or WebP image.')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error('This image cannot be read.')
  }
  try {
    const { width, height } = bannerSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('The image could not be encoded.')
    ctx.drawImage(bitmap, 0, 0, width, height)
    let blob = await encode(canvas, 'image/webp')
    const again = fallbackType(blob.type)
    if (again) {
      const fill = opaqueFill(again)
      if (fill !== null) {
        ctx.globalCompositeOperation = 'destination-over'
        ctx.fillStyle = fill
        ctx.fillRect(0, 0, width, height)
      }
      blob = await encode(canvas, again)
    }
    const type = blob.type || again || 'image/webp'
    return new File([blob], bannerFileName(type), { type })
  } finally {
    bitmap.close()
  }
}
