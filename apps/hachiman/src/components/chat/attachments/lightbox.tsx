import { Download } from 'lucide-react'
import type { AttachmentPointer } from '@hachiman/crypto'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAction } from '@/hooks/use-action'
import { downloadAttachment, useDecryptedBlob } from '@/hooks/use-decrypted-blob'
import { formatBytes } from '@/lib/format-bytes'

/**
 * One image in a window: file name title bar, the full decrypted image at up to 80% of the
 * viewport, and a download. A decrypted image never opens as its own page.
 */
export function Lightbox({
  image,
  onClose
}: {
  image: AttachmentPointer | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="w-fit min-w-80 gap-0 p-0 sm:max-w-[90vw]"
      >
        {image && <LightboxBody image={image} />}
      </DialogContent>
    </Dialog>
  )
}

function LightboxBody({ image }: { image: AttachmentPointer }): React.JSX.Element {
  const { url, error } = useDecryptedBlob(image)
  const save = useAction()
  return (
    <>
      <DialogTitle className="min-h-10 min-w-0 border-b px-4 pr-14">
        <span className="truncate font-mono text-[13px] font-normal">{image.name}</span>
      </DialogTitle>
      <div
        className="bg-rail flex min-h-40 items-center justify-center"
        style={fitViewport(image.width, image.height)}
      >
        {url ? (
          <img
            src={url}
            alt={image.name}
            className="block max-h-[80vh] max-w-[90vw] object-contain"
          />
        ) : (
          <span className="text-muted-foreground p-6 text-xs" title={error ?? undefined}>
            {error ? 'Unable to decrypt this image.' : 'Decrypting…'}
          </span>
        )}
      </div>
      <div className="bg-sidebar text-muted-foreground flex items-center justify-between gap-4 border-t px-4 py-2 text-xs tabular-nums">
        <span className={save.error ? 'text-destructive' : undefined}>
          {save.error ??
            `${image.width && image.height ? `${image.width} × ${image.height}, ` : ''}${formatBytes(image.size)}`}
        </span>
        <button
          type="button"
          disabled={save.busy}
          onClick={() => void save.run('download the image', () => downloadAttachment(image))}
          className="text-foreground focus-visible:outline-ring flex items-center gap-1.5 font-medium underline-offset-2 outline-none hover:underline focus-visible:outline-2"
        >
          Download
          <Download className="size-3.5" aria-hidden />
        </button>
      </div>
    </>
  )
}

/** Known size: as large as the original allows within 90vw × 80vh, with the box set before load. */
function fitViewport(width: number | null, height: number | null): React.CSSProperties | undefined {
  if (!width || !height) return undefined
  return {
    width: `min(${width}px, 90vw, calc(80vh * ${width} / ${height}))`,
    aspectRatio: `${width} / ${height}`
  }
}
