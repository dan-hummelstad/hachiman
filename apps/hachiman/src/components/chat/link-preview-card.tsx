import { useEffect, useRef, useState } from 'react'
import type { LinkPreview } from '@hachiman/crypto'
import { useDecryptedBlob } from '@/hooks/use-decrypted-blob'
import { previewUrlOf } from '@/lib/link-preview'
import { loadLinkPreview, type ViewedLinkPreview } from '@/services/link-preview'
import { takusenService } from '@/services/TakusenService'
import { usePlatform } from '@/shared/PlatformContext'
import { usePrefsStore } from '@/stores/prefsStore'

/** The image of a card: `src` is null while it decrypts. A size, when known, holds the space. */
interface CardImage {
  src: string | null
  width?: number
  height?: number
}

/**
 * The preview of the first https link in `text`, fetched by this device when the message comes
 * into view (§12.8.1). Nothing while it loads, when the setting is off, or on a host that cannot
 * fetch (browser).
 */
export function ViewedLinkPreviewCard({ text }: { text: string }): React.JSX.Element | null {
  const url = previewUrlOf(text, takusenService.env.issuerOrigin)
  const on = usePrefsStore((s) => s.linkPreviews)
  const canFetch = usePlatform().fetchLinkResource !== null
  const ref = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<ViewedLinkPreview | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!url || !on || !canFetch || !el) return
    let live = true
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return
      seen.disconnect()
      void loadLinkPreview(url).then((p) => live && setPreview(p))
    })
    seen.observe(el)
    return () => {
      live = false
      seen.disconnect()
    }
  }, [url, on, canFetch])
  if (!url || !on || !canFetch) return null
  return (
    <div ref={ref}>
      {preview && <Card preview={preview} image={preview.image ? { src: preview.image } : null} />}
    </div>
  )
}

/**
 * A preview that the sender made (older messages, §12.8.1). The image is an encrypted blob: it
 * shows only through use-decrypted-blob.
 */
export function LinkPreviewCard({ preview }: { preview: LinkPreview }): React.JSX.Element {
  const { url } = useDecryptedBlob(preview.image)
  return (
    <Card
      preview={preview}
      image={
        preview.image && { src: url, width: preview.image.width, height: preview.image.height }
      }
    />
  )
}

/** The page chose every field, so the card names the real host of `url`, the target of every click. */
function Card({
  preview,
  image
}: {
  preview: Pick<LinkPreview, 'url' | 'title' | 'description' | 'siteName'>
  image: CardImage | null
}): React.JSX.Element {
  const host = new URL(preview.url).host
  // A link straight to an image (no page text): the image alone, as Discord embeds it.
  if (image && !preview.title && !preview.description)
    return (
      <a
        href={preview.url}
        target="_blank"
        rel="noreferrer noopener"
        data-slot="link-preview"
        aria-label={`Image from ${host}`}
        className="my-1 block w-fit max-w-full"
      >
        <PreviewImage image={image} maxWidth={400} maxHeight={350} fit="contain" />
      </a>
    )
  const title = preview.title || preview.url
  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noreferrer noopener"
      data-slot="link-preview"
      className="bg-surface-panel border-line-hairline hover:bg-surface-raised my-1 flex w-[440px] max-w-full flex-col border border-l-accent-primary border-l-2 no-underline"
    >
      <div className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5">
        <span className="text-text-tertiary text-meta truncate">
          {preview.siteName ? `${preview.siteName} · ${host}` : host}
        </span>
        <span className="text-accent-text truncate font-semibold">{title}</span>
        {preview.description && (
          <span className="text-text-secondary line-clamp-3 text-sm">{preview.description}</span>
        )}
      </div>
      {image && <PreviewImage image={image} maxHeight={300} fit="cover" />}
    </a>
  )
}

/** Without `maxWidth` the image fills the card width. Without a size it takes its own. */
function PreviewImage({
  image,
  maxWidth,
  maxHeight,
  fit
}: {
  image: CardImage
  maxWidth?: number
  maxHeight: number
  fit: 'cover' | 'contain'
}): React.JSX.Element | null {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  const sized = image.width !== undefined && image.height !== undefined
  return (
    <div
      className="bg-surface-raised max-w-full overflow-hidden"
      style={{
        width:
          maxWidth === undefined ? '100%' : sized ? Math.min(maxWidth, image.width!) : undefined,
        maxWidth,
        aspectRatio: sized ? `${image.width} / ${image.height}` : undefined,
        maxHeight
      }}
    >
      {image.src && (
        <img
          src={image.src}
          alt=""
          onError={() => setBroken(true)}
          className={
            sized
              ? fit === 'cover'
                ? 'size-full object-cover'
                : 'size-full object-contain'
              : 'block max-h-[inherit] w-full object-contain'
          }
        />
      )}
    </div>
  )
}
