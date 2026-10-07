import { useState } from 'react'
import { Upload } from 'lucide-react'
import { cn } from '@/lib/utils'

const hasFiles = (e: React.DragEvent): boolean => e.dataTransfer.types.includes('Files')

/**
 * Makes its area a file drop target. While a file is dragged over it, an overlay covers the area
 * and takes over the drag events, so moving across children never flickers it off.
 */
export function DropZone({
  enabled,
  label,
  onFiles,
  className,
  children
}: {
  enabled: boolean
  /** Where the files go, e.g. "#general". */
  label: string
  onFiles: (files: File[]) => void
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  return (
    <div
      className={cn('relative', className)}
      onDragEnter={(e) => {
        if (enabled && hasFiles(e)) setOver(true)
      }}
    >
      {children}
      {enabled && over && (
        <div
          className="bg-surface-content/85 absolute inset-0 z-30 flex items-center justify-center p-4"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            onFiles([...e.dataTransfer.files])
          }}
        >
          <div className="bg-surface-panel border-accent-primary pointer-events-none flex flex-col items-center gap-2 border-2 border-dashed px-10 py-8 text-center shadow-lg">
            <Upload className="text-accent-text size-6" aria-hidden />
            <p className="text-[15px] leading-5 font-semibold">Drop files to upload</p>
            <p className="text-text-secondary text-sm">
              They will be attached to your next message in {label}.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
