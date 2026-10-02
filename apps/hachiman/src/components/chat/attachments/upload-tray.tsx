import { FileIcon, Music, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format-bytes'
import type { PendingUpload } from './use-uploads'

/** The composer's pending attachments: one square tile each, uploading as soon as they land. */
export function UploadTray({
  items,
  onRemove
}: {
  items: PendingUpload[]
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (items.length === 0) return null
  return (
    <ul aria-label="Attachments" className="flex gap-2 overflow-x-auto border-b px-3 pt-3 pb-2.5">
      {items.map((u) => (
        <UploadTile key={u.id} upload={u} onRemove={() => onRemove(u.id)} />
      ))}
    </ul>
  )
}

function UploadTile({
  upload,
  onRemove
}: {
  upload: PendingUpload
  onRemove: () => void
}): React.JSX.Element {
  const { file, kind, preview, progress, attachment, error } = upload
  const uploading = !attachment && !error
  return (
    <li
      className={cn(
        'bg-background relative flex w-32 shrink-0 flex-col border',
        error && 'border-destructive'
      )}
    >
      <div className="bg-muted relative flex h-24 items-center justify-center overflow-hidden">
        {kind === 'image' && preview ? (
          <img src={preview} alt="" className="size-full object-cover" />
        ) : kind === 'video' && preview ? (
          // The fragment asks for a frame past 0, which some encoders leave black.
          <video
            src={`${preview}#t=0.1`}
            muted
            preload="metadata"
            className="size-full object-cover"
          />
        ) : (
          <TileGlyph kind={kind} name={file.name} />
        )}
        {uploading && (
          <div
            role="progressbar"
            aria-label={`Uploading ${file.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="bg-background/70 absolute inset-x-0 bottom-0 h-1"
          >
            <div
              className="bg-primary h-full transition-[width] duration-150"
              style={{ width: `${Math.max(progress * 100, 2)}%` }}
            />
          </div>
        )}
      </div>
      <div className="min-w-0 px-2 py-1.5">
        <p className="truncate font-mono text-xs leading-4" title={file.name}>
          {file.name}
        </p>
        <p
          className={cn(
            'truncate text-[11px] leading-4 tabular-nums',
            error ? 'text-destructive' : 'text-muted-foreground'
          )}
          title={error ?? undefined}
        >
          {error ??
            (uploading
              ? `${Math.round(progress * 100)}% of ${formatBytes(file.size)}`
              : formatBytes(file.size))}
        </p>
      </div>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        title="Remove"
        onClick={onRemove}
        className={cn(
          'bg-popover text-muted-foreground absolute -top-2 -right-2 flex size-6 items-center justify-center border shadow-md',
          'hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-ring outline-none focus-visible:outline-2'
        )}
      >
        <X className="size-3.5" />
      </button>
    </li>
  )
}

function TileGlyph({
  kind,
  name
}: {
  kind: PendingUpload['kind']
  name: string
}): React.JSX.Element {
  const Glyph = kind === 'audio' ? Music : FileIcon
  const ext = name.includes('.') ? name.split('.').pop() : undefined
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-1">
      <Glyph className="size-7" strokeWidth={1.5} aria-hidden />
      {ext && <span className="font-mono text-[11px] leading-4 lowercase">.{ext}</span>}
    </div>
  )
}
