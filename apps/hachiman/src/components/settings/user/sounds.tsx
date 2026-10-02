import { Play } from 'lucide-react'
import { Field, SectionHeading } from '@/components/ui/field'
import { IconButton } from '@/components/ui/icon-button'
import { Switch } from '@/components/ui/switch'
import { SOUND_EVENTS, type SoundEvent } from '@/lib/sounds'
import { previewSound } from '@/services/SoundService'
import { usePrefsStore } from '@/stores/prefsStore'

const SOUND_LABELS: Record<SoundEvent, string> = {
  message: 'Message received (DMs and mentions)',
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
  userStreamStop: 'Someone stops sharing'
}

export function SoundSettings(): React.JSX.Element {
  const enabled = usePrefsStore((s) => s.soundsEnabled)
  const volume = usePrefsStore((s) => s.soundVolume)
  const disabled = usePrefsStore((s) => s.disabledSounds)
  const setEnabled = usePrefsStore((s) => s.setSoundsEnabled)
  const setVolume = usePrefsStore((s) => s.setSoundVolume)
  const setSoundEnabled = usePrefsStore((s) => s.setSoundEnabled)
  return (
    <section className="grid gap-3">
      <SectionHeading>Sounds</SectionHeading>
      <label className="flex items-center justify-between gap-4 text-sm">
        Play sounds
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </label>
      <Field id="sound-volume" label="Sound volume">
        <input
          id="sound-volume"
          type="range"
          min={0}
          max={100}
          value={Math.round(volume * 100)}
          disabled={!enabled}
          onChange={(e) => setVolume(Number(e.target.value) / 100)}
          // ponytail: previews on pointer release only; keyboard users have the play buttons.
          onPointerUp={() => previewSound('message')}
          className="accent-primary w-full disabled:opacity-50"
        />
      </Field>
      <ul className="grid gap-1 sm:grid-cols-2 sm:gap-x-6">
        {SOUND_EVENTS.map((event) => (
          <li key={event} className="flex items-center gap-2 text-sm">
            <label className="flex flex-1 items-center justify-between gap-4">
              {SOUND_LABELS[event]}
              <Switch
                checked={!disabled.includes(event)}
                disabled={!enabled}
                onCheckedChange={(on) => setSoundEnabled(event, on)}
              />
            </label>
            <IconButton
              size="sm"
              label={`Play "${SOUND_LABELS[event]}"`}
              disabled={!enabled}
              onClick={() => previewSound(event)}
            >
              <Play />
            </IconButton>
          </li>
        ))}
      </ul>
    </section>
  )
}
