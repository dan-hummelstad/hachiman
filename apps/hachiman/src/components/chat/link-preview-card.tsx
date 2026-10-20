import type { LinkPreview } from '@hachiman/crypto'
import { useDecryptedBlob } from '@/hooks/use-decrypted-blob'

/**
 * The sender-made preview of a link in the message (§12.8.1). The sender chose every field, so
 * the card names the real host of `url`, the target of every click. The image is an encrypted
 * blob: it shows only through use-decrypted-blob. No fetch of the page from this device.
 */
export function LinkPreviewCard({ preview }: { preview: LinkPreview }): React.JSX.Element {
  // The decoder admits only an https URL that parses (§12.8.1).
  const host = new URL(preview.url).host
  // A link straight to an image (no page text): the image alone, as Discord embeds it.
  if (preview.image && !preview.title && !preview.description)
    return (
      <a
        href={preview.url}
        target="_blank"
        rel="noreferrer noopener"
        data-slot="link-preview"
        aria-label={`Image from ${host}`}
        className="my-1 block w-fit max-w-full"
      >
        <PreviewImage image={preview.image} maxWidth={400} maxHeight={350} fit="contain" />
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
      {preview.image && <PreviewImage image={preview.image} maxHeight={300} fit="cover" />}
    </a>
  )
}

/** Without `maxWidth` the image fills the card width. */
function PreviewImage({
  image,
  maxWidth,
  maxHeight,
  fit
}: {
  image: NonNullable<LinkPreview['image']>
  maxWidth?: number
  maxHeight: number
  fit: 'cover' | 'contain'
}): React.JSX.Element {
  const { url } = useDecryptedBlob(image)
  return (
    <div
      className="bg-surface-raised max-w-full overflow-hidden"
      style={{
        width: maxWidth === undefined ? '100%' : Math.min(maxWidth, image.width),
        aspectRatio: `${image.width} / ${image.height}`,
        maxHeight
      }}
    >
      {url && (
        <img
          src={url}
          alt=""
          className={fit === 'cover' ? 'size-full object-cover' : 'size-full object-contain'}
        />
      )}
    </div>
  )
}
