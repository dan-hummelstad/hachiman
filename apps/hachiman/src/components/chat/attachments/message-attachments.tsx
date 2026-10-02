import { useState } from 'react'
import { Download, FileIcon, Music } from 'lucide-react'
import { embedKind, type Attachment } from '@hachiman/client'
import { cn } from '@/lib/utils'
import { hachiman } from '@/services/hachiman'
import { formatBytes } from '@/lib/format-bytes'
import { EMBED_MAX, embedBox } from './format'
import { Lightbox } from './lightbox'

/**
 * A message's attachments under its text, Discord-style: images as one inline embed or a mosaic,
 * video and audio as players, everything else as a download card. Upload order is kept within
 * each group; images come first.
 */
export function MessageAttachments({
  attachments
}: {
  attachments: Attachment[]
}): React.JSX.Element {
  const [open, setOpen] = useState<Attachment | null>(null)
  const images = attachments.filter((a) => embedKind(a.contentType) === 'image')
  const rest = attachments.filter((a) => embedKind(a.contentType) !== 'image')
  return (
    <div className="flex flex-col items-start gap-1 py-1">
      {images.length === 1 ? (
        <InlineImage image={images[0]} onOpen={setOpen} />
      ) : (
        images.length > 1 && <Mosaic images={images} onOpen={setOpen} />
      )}
      {rest.map((a) => {
        const kind = embedKind(a.contentType)
        return kind === 'video' ? (
          <VideoEmbed key={a.id} video={a} />
        ) : kind === 'audio' ? (
          <AudioCard key={a.id} audio={a} />
        ) : (
          <FileCard key={a.id} file={a} />
        )
      })}
      <Lightbox image={open} onClose={() => setOpen(null)} />
    </div>
  )
}

const url = (a: Attachment): string => hachiman.rest.fileUrl(a.key)

const MEDIA_FRAME = 'bg-muted block max-w-full border'
const FOCUS =
  'focus-visible:outline-ring outline-none focus-visible:outline-2 focus-visible:outline-offset-1'

function InlineImage({
  image,
  onOpen
}: {
  image: Attachment
  onOpen: (a: Attachment) => void
}): React.JSX.Element {
  const box = embedBox(image.width, image.height)
  return (
    <button
      type="button"
      aria-label={`Open ${image.filename}`}
      onClick={() => onOpen(image)}
      className={cn(MEDIA_FRAME, FOCUS, 'cursor-zoom-in overflow-hidden')}
      style={box}
    >
      <img
        src={url(image)}
        alt={image.filename}
        loading="lazy"
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
  images: Attachment[]
  onOpen: (a: Attachment) => void
}): React.JSX.Element {
  const cols = images.length === 2 || images.length === 4 ? 2 : 3
  return (
    <div
      className={cn('grid max-w-full gap-1', cols === 2 ? 'grid-cols-2' : 'grid-cols-3')}
      style={{ width: EMBED_MAX.width }}
    >
      {images.map((image) => (
        <button
          key={image.id}
          type="button"
          aria-label={`Open ${image.filename}`}
          onClick={() => onOpen(image)}
          className={cn(MEDIA_FRAME, FOCUS, 'aspect-square cursor-zoom-in overflow-hidden')}
        >
          <img
            src={url(image)}
            alt={image.filename}
            loading="lazy"
            className="size-full object-cover"
          />
        </button>
      ))}
    </div>
  )
}

function VideoEmbed({ video }: { video: Attachment }): React.JSX.Element {
  const box = embedBox(video.width, video.height) ?? {
    width: EMBED_MAX.width,
    aspectRatio: '16 / 9'
  }
  return (
    <video
      src={url(video)}
      controls
      preload="metadata"
      aria-label={video.filename}
      className={cn(MEDIA_FRAME, 'bg-black')}
      style={box}
    />
  )
}

const CARD = 'bg-card flex max-w-full flex-col border'

function AudioCard({ audio }: { audio: Attachment }): React.JSX.Element {
  return (
    <div className={cn(CARD, 'gap-2 p-2.5')} style={{ width: EMBED_MAX.width }}>
      <FileHeader file={audio} icon={Music} />
      <audio src={url(audio)} controls preload="metadata" className="h-9 w-full" />
    </div>
  )
}

function FileCard({ file }: { file: Attachment }): React.JSX.Element {
  return (
    <div className={cn(CARD, 'p-2.5')} style={{ width: EMBED_MAX.width }}>
      <FileHeader file={file} icon={FileIcon} />
    </div>
  )
}

function FileHeader({
  file,
  icon: Icon
}: {
  file: Attachment
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
}): React.JSX.Element {
  const href = url(file)
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Icon className="text-muted-foreground size-8 shrink-0" strokeWidth={1.25} />
      <div className="min-w-0 flex-1">
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          download={file.filename}
          title={file.filename}
          className={cn(
            'text-foreground block truncate font-mono text-[13px] leading-5 underline-offset-2 hover:underline',
            FOCUS
          )}
        >
          {file.filename}
        </a>
        <p className="text-muted-foreground text-xs leading-4 tabular-nums">
          {formatBytes(file.size)}
        </p>
      </div>
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        download={file.filename}
        aria-label={`Download ${file.filename}`}
        title="Download"
        className={cn(
          'text-muted-foreground hover:bg-accent hover:text-foreground flex size-8 shrink-0 items-center justify-center',
          FOCUS
        )}
      >
        <Download className="size-4" />
      </a>
    </div>
  )
}
