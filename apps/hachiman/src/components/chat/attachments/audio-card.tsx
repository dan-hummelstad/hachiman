import { useEffect, useRef, useState } from 'react'
import { Download, LoaderCircle, Pause, Play } from 'lucide-react'
import type { AttachmentPointer } from '@hachiman/crypto'
import { useAction } from '@/hooks/use-action'
import { decryptBlob, downloadAttachment, useDecryptedBlob } from '@/hooks/use-decrypted-blob'
import { formatBytes } from '@/lib/format-bytes'
import { cn } from '@/lib/utils'
import { formatClock } from '@/lib/time-format'
import { downsamplePeaks, WAVEFORM_BARS } from '@/lib/waveform'
import { useCryptoStore } from '@/stores/cryptoStore'

interface Waveform {
  peaks: number[]
  /** Seconds. */
  duration: number
}

/** Files above this size get no waveform: the card does not decrypt them before a play. */
const WAVEFORM_MAX_BYTES = 16 * 1024 * 1024
/** Waveforms kept in memory, by attachment. */
const CACHE_ENTRIES = 64
const waveforms = new Map<string, Promise<Waveform>>()

const keyOf = (a: AttachmentPointer): string => `${a.uploadId}:${a.sha256}`

/**
 * The waveform of an audio attachment: decrypt, decode with Web Audio, downsample. Cached by
 * attachment in memory (the oldest entry goes first). A failed decode is not cached.
 */
function loadWaveform(audio: AttachmentPointer): Promise<Waveform> {
  const key = keyOf(audio)
  const hit = waveforms.get(key)
  if (hit) return hit
  const job = (async (): Promise<Waveform> => {
    const blob = await decryptBlob(audio)
    // An offline context decodes without a running audio device or a user gesture.
    const ctx = new OfflineAudioContext(1, 1, 44_100)
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
    const channels: Float32Array[] = []
    for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i))
    return { peaks: downsamplePeaks(channels, WAVEFORM_BARS), duration: buffer.duration }
  })()
  waveforms.set(key, job)
  job.catch(() => waveforms.delete(key))
  if (waveforms.size > CACHE_ENTRIES) waveforms.delete(waveforms.keys().next().value as string)
  return job
}

function useWaveform(audio: AttachmentPointer): Waveform | null {
  const ready = useCryptoStore((s) => s.phase === 'ready')
  const [state, setState] = useState<{ key: string; value: Waveform } | null>(null)
  const key = keyOf(audio)
  const eligible = ready && audio.size <= WAVEFORM_MAX_BYTES
  useEffect(() => {
    if (!eligible) return
    let live = true
    loadWaveform(audio).then(
      (value) => live && setState({ key, value }),
      (e: unknown) => console.warn('[chat] waveform failed', e)
    )
    return () => {
      live = false
    }
    // The key names the attachment: a new pointer object for the same file must not load again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, eligible])
  return state?.key === key ? state.value : null
}

const FOCUS =
  'focus-visible:outline-line-focus outline-none focus-visible:outline-2 focus-visible:outline-offset-1'
/** Flat bars while the waveform loads (or when the file is too big for one). */
const FLAT = new Array<number>(WAVEFORM_BARS).fill(0.12)

/**
 * Audio (N24, B1): play button, name and size, the waveform with the played part in the accent
 * colour, "0:04 / 0:12", and download. The waveform decodes from the decrypted file; playback
 * uses an `<audio>` element on the decrypted object URL, which loads on the first play.
 */
export function AudioCard({ audio }: { audio: AttachmentPointer }): React.JSX.Element {
  const wave = useWaveform(audio)
  const [started, setStarted] = useState(false)
  const { url, error } = useDecryptedBlob(started ? audio : null)
  const player = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [mediaDuration, setMediaDuration] = useState(0)
  const download = useAction()

  const duration = wave?.duration ?? mediaDuration
  const progress = duration > 0 ? Math.min(1, position / duration) : 0
  const loading = started && !url && !error

  const toggle = (): void => {
    if (!started) return setStarted(true)
    const el = player.current
    if (!el) return
    if (el.paused) void el.play().catch(() => setPlaying(false))
    else el.pause()
  }

  const seek = (e: React.MouseEvent<HTMLDivElement>): void => {
    const el = player.current
    if (!el || duration <= 0) return
    const box = e.currentTarget.getBoundingClientRect()
    el.currentTime = ((e.clientX - box.left) / box.width) * duration
  }

  const bars = wave?.peaks ?? FLAT
  const played = Math.round(progress * bars.length)

  return (
    <div
      className="bg-surface-panel border-line-hairline flex w-[440px] max-w-full items-center gap-3 border px-3 py-2.5"
      data-slot="audio-card"
    >
      <button
        type="button"
        aria-label={playing ? `Pause ${audio.name}` : `Play ${audio.name}`}
        disabled={loading}
        onClick={toggle}
        className={cn(
          'rounded-control bg-accent-primary text-text-on-accent hover:bg-accent-primary/90 flex size-10 shrink-0 items-center justify-center disabled:opacity-70',
          FOCUS
        )}
      >
        {loading ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : playing ? (
          <Pause className="size-4 fill-current" />
        ) : (
          <Play className="size-4 fill-current" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-baseline gap-2">
          <span
            className="text-text-primary truncate text-[14px] leading-5 font-bold"
            title={audio.name}
          >
            {audio.name}
          </span>
          <span className="text-text-tertiary text-meta shrink-0 tabular-nums">
            {formatBytes(audio.size)}
          </span>
        </p>
        {error ? (
          <p className="text-feature-danger-text text-xs leading-6" title={error}>
            Unable to decrypt this file.
          </p>
        ) : (
          <div className="flex items-center gap-3">
            <div
              aria-hidden
              onClick={seek}
              className={cn(
                'flex h-6 min-w-0 flex-1 items-center gap-[2px]',
                url && 'cursor-pointer'
              )}
            >
              {bars.map((p, i) => (
                <span
                  key={i}
                  className={cn(
                    'min-w-px flex-1 rounded-full',
                    i < played ? 'bg-accent-primary' : 'bg-accent-primary/35'
                  )}
                  style={{ height: `${Math.round(Math.max(p, 0.08) * 100)}%` }}
                />
              ))}
            </div>
            <span className="text-text-tertiary text-meta shrink-0 tabular-nums">
              {formatClock(position * 1000)} / {formatClock(duration * 1000)}
            </span>
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={() => void download.run('download the file', () => downloadAttachment(audio))}
        disabled={download.busy}
        aria-label={`Download ${audio.name}`}
        title={download.error ?? 'Download'}
        className={cn(
          'rounded-control text-text-tertiary hover:bg-surface-hover hover:text-text-primary flex size-8 shrink-0 items-center justify-center',
          download.error && 'text-feature-danger-text',
          FOCUS
        )}
      >
        {download.busy ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <Download className="size-4" />
        )}
      </button>
      {url && (
        <audio
          ref={player}
          src={url}
          autoPlay
          preload="auto"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setPosition(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration
            if (Number.isFinite(d)) setMediaDuration(d)
          }}
          className="hidden"
        />
      )}
    </div>
  )
}
