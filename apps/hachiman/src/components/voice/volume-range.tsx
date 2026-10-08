import { cn } from '@/lib/utils'
import type { UserAudio } from '@/stores/prefsStore'

/** A local volume slider, 0–200 % in steps of 5. Off while the audio is locally muted. */
export function VolumeRange({
  label,
  audio,
  onVolume,
  className
}: {
  label: string
  audio: UserAudio
  /** 0..2 */
  onVolume: (volume: number) => void
  className?: string
}): React.JSX.Element {
  return (
    <input
      aria-label={label}
      type="range"
      min={0}
      max={200}
      step={5}
      value={Math.round(audio.volume * 100)}
      disabled={audio.muted}
      onChange={(e) => onVolume(Number(e.target.value) / 100)}
      className={cn('accent-accent-primary disabled:opacity-50', className)}
    />
  )
}
