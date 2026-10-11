import { Download } from 'lucide-react'
import type { AttachmentPointer } from '@hachiman/crypto'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAction } from '@/hooks/use-action'
import { downloadAttachment, useDecryptedBlob } from '@/hooks/use-decrypted-blob'
import { useLayout } from '@/hooks/use-layout'
import { formatBytes } from '@/lib/format-bytes'
import { cn } from '@/lib/utils'

/**
 * One image in a window: file name title bar, the full decrypted image at up to 80% of the
 * viewport, and a download. A decrypted image never opens as its own page. On the mobile layout
 * the window fills the screen inside the safe areas and the image fits the space between the bars.
 */
export function Lightbox({
  image,
  onClose
}: {
  image: AttachmentPointer | null
  onClose: () => void
}): React.JSX.Element {
  const mobile = useLayout() === 'mobile'
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        presentation="fullscreen"
        aria-describedby={undefined}
        className={mobile ? undefined : 'w-fit min-w-80 gap-0 p-0 sm:max-w-[90vw]'}
      >
        {image && <LightboxBody image={image} mobile={mobile} />}
      </DialogContent>
    </Dialog>
  )
}

function LightboxBody({
  image,
  mobile
}: {
  image: AttachmentPointer
  mobile: boolean
}): React.JSX.Element {
  const { url, error } = useDecryptedBlob(image)
  const save = useAction()
  return (
    <>
      <DialogTitle
        className={cn('min-w-0 border-b px-4 pr-14', mobile ? 'min-h-[52px] shrink-0' : 'min-h-10')}
      >
        <span className="truncate font-mono text-[13px] font-normal">{image.name}</span>
      </DialogTitle>
      <div
        className={cn(
          'bg-rail flex items-center justify-center',
          mobile ? 'min-h-0 flex-1' : 'min-h-40'
        )}
        style={mobile ? undefined : fitViewport(image.width, image.height)}
      >
        {url ? (
          <img
            src={url}
            alt={image.name}
            className={cn(
              'block object-contain',
              mobile ? 'size-full' : 'max-h-[80vh] max-w-[90vw]'
            )}
          />
        ) : (
          <span className="text-text-tertiary p-6 text-xs" title={error ?? undefined}>
            {error ? 'Unable to decrypt this image.' : 'Decrypting…'}
          </span>
        )}
      </div>
      <div
        className={cn(
          'bg-surface-panel border-line-hairline text-text-tertiary flex items-center justify-between gap-4 border-t px-4 text-xs tabular-nums',
          // The panel colour runs under the home indicator (§2.7).
          mobile ? 'min-h-[calc(48px+var(--safe-bottom))] shrink-0 pb-(--safe-bottom)' : 'py-2'
        )}
      >
        <span className={save.error ? 'text-feature-danger-text' : undefined}>
          {save.error ??
            `${image.width && image.height ? `${image.width} × ${image.height}, ` : ''}${formatBytes(image.size)}`}
        </span>
        <button
          type="button"
          disabled={save.busy}
          onClick={() => void save.run('download the image', () => downloadAttachment(image))}
          className={cn(
            'text-text-primary focus-visible:outline-line-focus flex items-center gap-1.5 font-medium underline-offset-2 outline-none hover:underline focus-visible:outline-2',
            // A 36 touch target around the link-sized label.
            mobile && 'rounded-control active:bg-surface-hover -mr-2 min-h-9 px-2 text-[13px]'
          )}
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
