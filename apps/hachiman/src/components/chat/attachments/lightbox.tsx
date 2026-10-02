import { ExternalLink } from 'lucide-react'
import type { Attachment } from '@hachiman/client'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { hachiman } from '@/services/hachiman'
import { formatBytes } from '@/lib/format-bytes'

/** One image in a window: filename title bar, the image at up to 80% of the viewport, a link out. */
export function Lightbox({
  image,
  onClose
}: {
  image: Attachment | null
  onClose: () => void
}): React.JSX.Element {
  const url = image ? hachiman.rest.fileUrl(image.key) : ''
  return (
    <Dialog open={image !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        aria-describedby={undefined}
        className="w-fit min-w-80 gap-0 p-0 sm:max-w-[90vw]"
      >
        {image && (
          <>
            <DialogTitle className="min-w-0">
              <span className="truncate font-mono text-[13px] font-normal">{image.filename}</span>
            </DialogTitle>
            <div className="bg-rail flex items-center justify-center">
              <img
                src={url}
                alt={image.filename}
                className="block max-h-[80vh] max-w-[90vw] object-contain"
                style={fitViewport(image.width, image.height)}
              />
            </div>
            <div className="bg-sidebar text-muted-foreground flex items-center justify-between gap-4 border-t px-4 py-2 text-xs tabular-nums">
              <span>
                {image.width && image.height ? `${image.width} × ${image.height}, ` : ''}
                {formatBytes(image.size)}
              </span>
              <a
                href={url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-foreground focus-visible:outline-ring flex items-center gap-1.5 font-medium underline-offset-2 outline-none hover:underline focus-visible:outline-2"
              >
                Open original
                <ExternalLink className="size-3.5" aria-hidden />
              </a>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
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
