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
      {preview.image && <PreviewImage image={preview.image} />}
    </a>
  )
}

function PreviewImage({ image }: { image: NonNullable<LinkPreview['image']> }): React.JSX.Element {
  const { url } = useDecryptedBlob(image)
  return (
    <div
      className="bg-surface-raised w-full overflow-hidden"
      style={{ aspectRatio: `${image.width} / ${image.height}`, maxHeight: 300 }}
    >
      {url && <img src={url} alt="" className="size-full object-cover" />}
    </div>
  )
}
