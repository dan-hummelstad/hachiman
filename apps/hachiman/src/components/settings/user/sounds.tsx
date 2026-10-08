import { useId } from 'react'
import { Play, Volume, Volume2 } from 'lucide-react'
import { SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'
import { SOUND_EVENTS, type SoundEvent } from '@/lib/sounds'
import { cn } from '@/lib/utils'
import { previewSound } from '@/services/SoundService'
import { usePrefsStore } from '@/stores/prefsStore'

const SOUND_LABELS: Record<SoundEvent, string> = {
  message: 'Message received',
  messageSent: 'Message sent',
  voiceJoin: 'You join voice',
  voiceLeave: 'You leave voice',
  voiceDisconnect: 'Voice disconnected',
  userJoin: 'Someone joins your channel',
  userLeave: 'Someone leaves your channel',
  mute: 'Mute',
  unmute: 'Unmute',
  deafen: 'Deafen',
  undeafen: 'Undeafen',
  streamStart: 'You start sharing',
  streamStop: 'You stop sharing',
  userStreamStart: 'Someone starts sharing',
  userStreamStop: 'Someone stops sharing',
  poke: 'Someone pokes you'
}

const SOUND_HINTS: Partial<Record<SoundEvent, string>> = { message: 'DMs and mentions' }

/** The master switch and volume, then one switch and play button per sound in two columns. */
export function SoundSettings(): React.JSX.Element {
  const enabled = usePrefsStore((s) => s.soundsEnabled)
  const volume = usePrefsStore((s) => s.soundVolume)
  const disabled = usePrefsStore((s) => s.disabledSounds)
  const setEnabled = usePrefsStore((s) => s.setSoundsEnabled)
  const setVolume = usePrefsStore((s) => s.setSoundVolume)
  const setSoundEnabled = usePrefsStore((s) => s.setSoundEnabled)
  const id = useId()
  const percent = Math.round(volume * 100)
  // Column-major: the first half fills the left column.
  const half = Math.ceil(SOUND_EVENTS.length / 2)

  return (
    <section className="grid gap-3">
      <SectionHeading className="mb-0">Sounds</SectionHeading>
      <div className="flex items-center gap-3">
        <Switch id={`${id}-all`} checked={enabled} onCheckedChange={setEnabled} />
        <label htmlFor={`${id}-all`} className="text-label w-40 cursor-pointer">
          Play sounds
        </label>
        <Volume aria-hidden className="text-text-tertiary size-4 shrink-0" />
        <input
          aria-label="Sound volume"
          type="range"
          min={0}
          max={100}
          value={percent}
          disabled={!enabled}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          // ponytail: previews on pointer release only; keyboard users have the play buttons.
          onPointerUp={() => previewSound('message')}
          className="accent-accent-primary min-w-0 flex-1 disabled:opacity-50"
        />
        <Volume2 aria-hidden className="text-text-tertiary size-4 shrink-0" />
        <span className="text-meta text-text-secondary w-9 text-right tabular-nums">
          {percent}%
        </span>
      </div>
      <ul
        className="grid grid-flow-col gap-x-10 gap-y-0.5"
        style={{ gridTemplateRows: `repeat(${half}, auto)` }}
      >
        {SOUND_EVENTS.map((event) => {
          const on = !disabled.includes(event)
          return (
            <li
              key={event}
              className={cn(
                'flex h-9 items-center gap-2',
                (!enabled || !on) && 'text-text-tertiary'
              )}
            >
              <label
                htmlFor={`${id}-${event}`}
                className="text-label flex min-w-0 flex-1 items-baseline gap-2 font-medium"
              >
                <span className="truncate">{SOUND_LABELS[event]}</span>
                {SOUND_HINTS[event] && (
                  <span className="text-meta text-text-tertiary truncate">
                    {SOUND_HINTS[event]}
                  </span>
                )}
              </label>
              <IconButton
                size="sm"
                label={`Play "${SOUND_LABELS[event]}"`}
                className="rounded-pill border-line-hairline border"
                disabled={!enabled}
                onClick={() => previewSound(event)}
              >
                <Play />
              </IconButton>
              <Switch
                id={`${id}-${event}`}
                checked={on}
                disabled={!enabled}
                onCheckedChange={(v) => setSoundEnabled(event, v)}
              />
            </li>
          )
        })}
      </ul>
    </section>
  )
}
