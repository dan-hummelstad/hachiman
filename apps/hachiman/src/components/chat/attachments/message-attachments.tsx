import { useState } from 'react'
import { Download, FileIcon, LoaderCircle, Play } from 'lucide-react'
import { embedKind } from '@hachiman/client'
import type { AttachmentPointer } from '@hachiman/crypto'
import { useAction } from '@/hooks/use-action'
import { downloadAttachment, useDecryptedBlob } from '@/hooks/use-decrypted-blob'
import { cn } from '@/lib/utils'
import { formatBytes } from '@/lib/format-bytes'
import { AudioCard } from './audio-card'
import { EMBED_MAX, embedBox } from './format'
import { Lightbox } from './lightbox'

/**
 * A message's attachments under its text, Discord-style: images as one inline embed or a mosaic,
 * video and audio as players, everything else as a download card. Envelope order is kept within
 * each group; images come first.
 *
 * Every file is decrypted (§12.9): the name, MIME type and dimensions come from the pointer in
 * the envelope, and the bytes from `/files/{uploadId}/blob` through the crypto Worker. Images
 * show their thumbnail inline. Audio decrypts for its waveform; video and other files decrypt only
 * when the user asks.
 */
export function MessageAttachments({
  attachments
}: {
  attachments: AttachmentPointer[]
}): React.JSX.Element {
  const [open, setOpen] = useState<AttachmentPointer | null>(null)
  const images = attachments.filter((a) => embedKind(a.mime) === 'image')
  const rest = attachments.filter((a) => embedKind(a.mime) !== 'image')
  return (
    <div className="flex flex-col items-start gap-1 py-1">
      {images.length === 1 ? (
        <InlineImage image={images[0]} onOpen={setOpen} />
      ) : (
        images.length > 1 && <Mosaic images={images} onOpen={setOpen} />
      )}
      {rest.map((a) => {
        const kind = embedKind(a.mime)
        return kind === 'video' ? (
          <VideoEmbed key={a.uploadId} video={a} />
        ) : kind === 'audio' ? (
          <AudioCard key={a.uploadId} audio={a} />
        ) : (
          <FileCard key={a.uploadId} file={a} />
        )
      })}
      <Lightbox image={open} onClose={() => setOpen(null)} />
    </div>
  )
}

const MEDIA_FRAME =
  'bg-surface-sunken border-line-hairline rounded-option block max-w-full overflow-hidden border'
const FOCUS =
  'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:outline-offset-1'

/** The thumbnail when the sender made one, else the full image. */
const preview = (a: AttachmentPointer): Parameters<typeof useDecryptedBlob>[0] => a.thumbnail ?? a

/** Shown in place of media that did not decrypt. */
function Unreadable({
  error,
  className
}: {
  error: string
  className?: string
}): React.JSX.Element {
  return (
    <span
      title={error}
      className={cn(
        'text-text-tertiary flex size-full items-center justify-center p-2 text-xs',
        className
      )}
    >
      Unable to decrypt
    </span>
  )
}

function DecryptedImg({
  image,
  className,
  style
}: {
  image: AttachmentPointer
  className: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const { url, error } = useDecryptedBlob(preview(image))
  if (error) return <Unreadable error={error} />
  return url ? (
    <img src={url} alt={image.name} className={className} style={style} />
  ) : (
    <span className="block size-full min-h-24 min-w-24 animate-pulse" aria-label="Decrypting" />
  )
}

function InlineImage({
  image,
  onOpen
}: {
  image: AttachmentPointer
  onOpen: (a: AttachmentPointer) => void
}): React.JSX.Element {
  const box = embedBox(image.width, image.height)
  return (
    <button
      type="button"
      aria-label={`Open ${image.name}`}
      onClick={() => onOpen(image)}
      className={cn(MEDIA_FRAME, FOCUS, 'cursor-zoom-in overflow-hidden')}
      style={box}
    >
      <DecryptedImg
        image={image}
        className={cn(
          'block',
          box ? 'size-full object-cover' : 'max-h-[300px] max-w-full object-contain'
        )}
        style={box ? undefined : { maxWidth: EMBED_MAX.width }}
      />
    </button>
  )
}

/** Square cells, two or three across: a plainer cousin of Discord's mosaic. */
function Mosaic({
  images,
  onOpen
}: {
  images: AttachmentPointer[]
  onOpen: (a: AttachmentPointer) => void
}): React.JSX.Element {
  const cols = images.length === 2 || images.length === 4 ? 2 : 3
  return (
    <div
      className={cn('grid max-w-full gap-1', cols === 2 ? 'grid-cols-2' : 'grid-cols-3')}
      style={{ width: EMBED_MAX.width }}
    >
      {images.map((image) => (
        <button
          key={image.uploadId}
          type="button"
          aria-label={`Open ${image.name}`}
          onClick={() => onOpen(image)}
          className={cn(MEDIA_FRAME, FOCUS, 'aspect-square cursor-zoom-in overflow-hidden')}
        >
          <DecryptedImg image={image} className="size-full object-cover" />
        </button>
      ))}
    </div>
  )
}

function VideoEmbed({ video }: { video: AttachmentPointer }): React.JSX.Element {
  const [started, setStarted] = useState(false)
  const poster = useDecryptedBlob(video.thumbnail)
  const full = useDecryptedBlob(started ? video : null)
  const box = embedBox(video.width, video.height) ?? {
    width: EMBED_MAX.width,
    aspectRatio: '16 / 9'
  }
  if (full.url) {
    return (
      <video
        src={full.url}
        poster={poster.url ?? undefined}
        controls
        autoPlay
        aria-label={video.name}
        className={cn(MEDIA_FRAME, 'bg-black')}
        style={box}
      />
    )
  }
  return (
    <div className={cn(CARD, 'max-w-full')} style={{ width: box.width }}>
      <button
        type="button"
        aria-label={`Play ${video.name}`}
        onClick={() => setStarted(true)}
        disabled={started && !full.error}
        className={cn(FOCUS, 'bg-surface-sunken relative block w-full overflow-hidden')}
        style={{ aspectRatio: box.aspectRatio, maxHeight: 300 }}
      >
        {poster.url && <img src={poster.url} alt="" className="size-full object-cover" />}
        <span className="absolute inset-0 flex items-center justify-center">
          {full.error ? (
            <Unreadable error={full.error} className="bg-surface-content/80 size-auto" />
          ) : started ? (
            <LoaderCircle className="text-text-primary size-8 animate-spin" />
          ) : (
            <span className="bg-surface-raised border-line-strong flex size-11 items-center justify-center rounded-full border">
              <Play className="fill-text-primary text-text-primary size-4" />
            </span>
          )}
        </span>
      </button>
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-text-primary truncate text-[13px] font-semibold" title={video.name}>
            {video.name}
          </p>
          <p className="text-text-disabled font-mono text-[9px] tracking-[0.8px] uppercase">
            {formatBytes(video.size)} · {mimeLabel(video.mime)}
          </p>
        </div>
      </div>
    </div>
  )
}

/** `video/mp4` as `MP4`. */
const mimeLabel = (mime: string): string => (mime.split('/')[1] ?? mime).toUpperCase()

/** Attachment card on the raised surface. */
const CARD =
  'bg-surface-raised border-line-hairline rounded-option flex max-w-full flex-col overflow-hidden border'

function FileCard({ file }: { file: AttachmentPointer }): React.JSX.Element {
  return (
    <div
      className={cn(CARD, 'rounded-control px-[13px] py-[11px]')}
      style={{ width: Math.min(EMBED_MAX.width, 400) }}
    >
      <FileHeader file={file} lead={<FileGlyph icon={FileIcon} />} />
    </div>
  )
}

function FileGlyph({
  icon: Icon
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}): React.JSX.Element {
  return (
    <span className="bg-surface-sunken text-text-secondary rounded-control flex size-[34px] shrink-0 items-center justify-center">
      <Icon className="size-4" strokeWidth={1.5} />
    </span>
  )
}

function FileHeader({
  file,
  lead
}: {
  file: AttachmentPointer
  lead: React.ReactNode
}): React.JSX.Element {
  const { run, busy, error } = useAction()
  const save = (): void => void run('download the file', () => downloadAttachment(file))
  return (
    <div className="flex min-w-0 items-center gap-3">
      {lead}
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={save}
          disabled={busy}
          title={file.name}
          className={cn(
            'text-text-primary block max-w-full truncate text-left text-[13px] leading-5 font-semibold underline-offset-2 hover:underline',
            FOCUS
          )}
        >
          {file.name}
        </button>
        <p
          className={cn(
            'font-mono text-[8.5px] tracking-[0.7px] uppercase tabular-nums',
            error ? 'text-you-text' : 'text-text-disabled'
          )}
          title={error ?? undefined}
        >
          {error ? 'Unable to decrypt this file.' : formatBytes(file.size)}
        </p>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        aria-label={`Download ${file.name}`}
        title="Download"
        className={cn(
          'rounded-control text-text-tertiary hover:bg-surface-hover hover:text-text-primary flex size-8 shrink-0 items-center justify-center',
          FOCUS
        )}
      >
        {busy ? <LoaderCircle className="size-4 animate-spin" /> : <Download className="size-4" />}
      </button>
    </div>
  )
}
