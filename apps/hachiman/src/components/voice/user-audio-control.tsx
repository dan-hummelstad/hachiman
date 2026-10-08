import { useId } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { DEFAULT_USER_AUDIO, usePrefsStore } from '@/stores/prefsStore'

/**
 * What I hear of one user in my call (Discord's user volume): a 0–200 % slider and a local mute.
 * Only this device plays it; the user does not know.
 */
export function UserAudioControl({ userId }: { userId: string }): React.JSX.Element {
  const audio = usePrefsStore((s) => s.userAudio[userId] ?? DEFAULT_USER_AUDIO)
  const setUserAudio = usePrefsStore((s) => s.setUserAudio)
  const id = useId()
  const percent = Math.round(audio.volume * 100)
  return (
    <div className="border-line-hairline flex flex-col gap-2 border-t pt-3">
      <span className="section-label">User volume</span>
      <div className="flex items-center gap-2">
        <Volume2 aria-hidden className="text-text-tertiary size-4 shrink-0" />
        <input
          aria-label="User volume"
          type="range"
          min={0}
          max={200}
          step={5}
          value={percent}
          disabled={audio.muted}
          onChange={(e) => setUserAudio(userId, { volume: Number(e.target.value) / 100 })}
          className="accent-accent-primary min-w-0 flex-1 disabled:opacity-50"
        />
        <span className="text-meta text-text-secondary w-10 text-right tabular-nums">
          {percent}%
        </span>
      </div>
      <div className="flex items-center gap-2">
        <VolumeX aria-hidden className="text-text-tertiary size-4 shrink-0" />
        <label htmlFor={`${id}-mute`} className="text-label flex-1 cursor-pointer">
          Mute for me
        </label>
        <Switch
          id={`${id}-mute`}
          checked={audio.muted}
          onCheckedChange={(muted) => setUserAudio(userId, { muted })}
        />
      </div>
    </div>
  )
}
