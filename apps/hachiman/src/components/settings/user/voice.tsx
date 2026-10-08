import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Headphones, Mic, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ErrorText, SectionHeading } from '@/components/ui/field'
import { Keycap } from '@/components/ui/keycap'
import { NativeSelect } from '@/components/ui/native-select'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Switch } from '@/components/ui/switch'
import { SoundSettings } from '@/components/settings/user/sounds'
import { useKeybindLabel } from '@/hooks/use-keybinds'
import { useMicLevel } from '@/hooks/use-mic-level'
import { errMsg } from '@/lib/utils'
import { setSettingsSection } from '@/stores/navStore'
import { usePrefsStore, type NoiseSuppression, type VoiceInputMode } from '@/stores/prefsStore'

const canPickOutput =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** User settings → Voice and audio (H6): the devices side by side, an opt-in mic check, sounds. */
export function VoiceSection(): React.JSX.Element {
  const inputDeviceId = usePrefsStore((s) => s.inputDeviceId)
  const outputDeviceId = usePrefsStore((s) => s.outputDeviceId)
  const setInputDeviceId = usePrefsStore((s) => s.setInputDeviceId)
  const setOutputDeviceId = usePrefsStore((s) => s.setOutputDeviceId)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [error, setError] = useState<string | null>(null)

  const supported = !!navigator.mediaDevices?.enumerateDevices
  const refresh = useCallback((): void => {
    navigator.mediaDevices
      ?.enumerateDevices?.()
      .then(setDevices, (e: unknown) => setError(`Could not list audio devices: ${errMsg(e)}`))
  }, [])

  useEffect(() => {
    refresh()
    const md = navigator.mediaDevices
    md?.addEventListener?.('devicechange', refresh)
    return () => md?.removeEventListener?.('devicechange', refresh)
  }, [refresh])

  // Exclude the browser's synthetic "default"/"communications" entries; null already means default.
  const real = (kind: MediaDeviceKind): MediaDeviceInfo[] =>
    devices.filter(
      (d) =>
        d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications'
    )
  const inputs = real('audioinput')
  const outputs = real('audiooutput')
  // Without mic permission the browser hides device labels.
  const unlabeled = inputs.length > 0 && inputs.every((d) => !d.label)

  return (
    <div className="grid gap-6">
      <section className="grid grid-cols-2 gap-4">
        <DeviceSelect
          id="input-device"
          label="Input device"
          icon={<Mic />}
          devices={inputs}
          value={inputDeviceId}
          onChange={setInputDeviceId}
          fallbackLabel="Microphone"
        />
        <DeviceSelect
          id="output-device"
          label="Output device"
          icon={<Headphones />}
          devices={outputs}
          value={outputDeviceId}
          onChange={setOutputDeviceId}
          fallbackLabel="Speaker"
          disabled={!canPickOutput}
          hint={canPickOutput ? undefined : 'This app can only play through the system default.'}
        />
      </section>
      {unlabeled && (
        <p className="text-meta text-text-tertiary">
          Device names are hidden until you allow microphone access. Use “Check microphone” below.
        </p>
      )}
      <ErrorText>
        {supported
          ? error
          : 'This app can’t list audio devices here, so the system default is used.'}
      </ErrorText>
      <NoiseSuppressionSelect />
      <InputMode />
      <MicCheck deviceId={inputDeviceId} onOpen={refresh} />
      <AudioQuality />
      <SoundSettings />
    </div>
  )
}

const INPUT_MODES = [
  { value: 'voiceActivity', label: 'Voice activity' },
  { value: 'pushToTalk', label: 'Push to talk' }
] as const

/** Voice activity sends when you speak; push to talk only while its key is held. */
function InputMode(): React.JSX.Element {
  const mode = usePrefsStore((s) => s.voiceInputMode)
  const setMode = usePrefsStore((s) => s.setVoiceInputMode)
  const key = useKeybindLabel('pushToTalk')
  const toKeybinds = (): void => setSettingsSection('keybinds')
  return (
    <section className="grid gap-2">
      <SectionHeading className="mb-0">Input mode</SectionHeading>
      <SegmentedControl<VoiceInputMode>
        label="Input mode"
        options={INPUT_MODES}
        value={mode}
        onChange={setMode}
        className="w-fit"
      />
      {mode === 'pushToTalk' && (
        <p className="text-meta text-text-tertiary">
          {key ? (
            <>
              Hold <Keycap>{key}</Keycap> to talk.{' '}
            </>
          ) : (
            'No push-to-talk key is set, so your microphone stays closed. '
          )}
          <Button variant="link" className="text-meta" onClick={toKeybinds}>
            {key ? 'Change the key' : 'Set a key'}
          </Button>
          . Push to talk works only while the Hachiman window is focused.
        </p>
      )}
    </section>
  )
}

function DeviceSelect(props: {
  id: string
  label: string
  icon: React.ReactNode
  devices: MediaDeviceInfo[]
  value: string | null
  onChange: (id: string | null) => void
  fallbackLabel: string
  disabled?: boolean
  hint?: string
}): React.JSX.Element {
  const { id, label, icon, devices, value, onChange, fallbackLabel, disabled, hint } = props
  const missing = value !== null && devices.length > 0 && !devices.some((d) => d.deviceId === value)
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={id}
        className="text-text-secondary flex items-center gap-1.5 text-xs leading-4 font-semibold [&_svg]:size-3.5"
      >
        {icon}
        {label}
      </label>
      <NativeSelect
        id={id}
        className="w-full [&_select]:h-10"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">System default</option>
        {devices.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${fallbackLabel} ${i + 1}`}
          </option>
        ))}
        {missing && <option value={value}>Disconnected device</option>}
      </NativeSelect>
      {hint && <p className="text-meta text-text-tertiary">{hint}</p>}
    </div>
  )
}

function NoiseSuppressionSelect(): React.JSX.Element {
  const value = usePrefsStore((s) => s.noiseSuppression)
  const setValue = usePrefsStore((s) => s.setNoiseSuppression)
  const id = useId()
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={id}
        className="text-text-secondary flex items-center gap-1.5 text-xs leading-4 font-semibold [&_svg]:size-3.5"
      >
        Noise suppression
      </label>
      <NativeSelect
        id={id}
        className="w-full [&_select]:h-10"
        value={value}
        onChange={(e) => setValue(e.target.value as NoiseSuppression)}
      >
        <option value="off">Off</option>
        <option value="browser">Standard (browser)</option>
        <option value="rnnoise">Enhanced (RNNoise)</option>
      </NativeSelect>
    </div>
  )
}

/** Opt-in mic level meter: opens the selected input only while checking. */
function MicCheck({
  deviceId,
  onOpen
}: {
  deviceId: string | null
  onOpen: () => void
}): React.JSX.Element {
  const barRef = useRef<HTMLSpanElement>(null)
  const { on, toggle, error } = useMicLevel(deviceId, barRef, onOpen)

  return (
    <section className="bg-surface-panel border-line-hairline grid gap-2 border px-3.5 py-3">
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="lg" onClick={toggle}>
          {on ? <Square /> : <Mic />}
          {on ? 'Stop check' : 'Check microphone'}
        </Button>
        <span
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          className="bg-surface-raised relative h-2.5 flex-1 overflow-hidden"
        >
          <span ref={barRef} className="bg-feature-voice absolute inset-y-0 left-0 w-0" />
          <span aria-hidden className="bg-surface-content absolute inset-y-0 left-1/4 w-0.5" />
        </span>
      </div>
      <p className="text-meta text-text-tertiary">
        Speak normally. The bar should move well past the first quarter mark.
      </p>
      <ErrorText>{error}</ErrorText>
    </section>
  )
}

/** Outgoing mic bitrates (Opus), bit/s. */
const MIC_BITRATES = [32_000, 64_000, 96_000, 128_000]

/** The mic send bitrate and the capture processing. Both apply to a live call. */
function AudioQuality(): React.JSX.Element {
  const micBitrate = usePrefsStore((s) => s.micBitrate)
  const echoCancellation = usePrefsStore((s) => s.echoCancellation)
  const setMicBitrate = usePrefsStore((s) => s.setMicBitrate)
  const setEchoCancellation = usePrefsStore((s) => s.setEchoCancellation)
  const id = useId()
  return (
    <section className="grid gap-3">
      <SectionHeading className="mb-0">Audio quality</SectionHeading>
      <div className="flex items-center gap-3">
        <label htmlFor={`${id}-bitrate`} className="text-label w-40">
          Microphone bitrate
        </label>
        <NativeSelect
          id={`${id}-bitrate`}
          value={String(micBitrate)}
          onChange={(e) => setMicBitrate(Number(e.target.value))}
        >
          {MIC_BITRATES.map((b) => (
            <option key={b} value={b}>
              {b / 1000} kbps{b === 64_000 ? ' (default)' : ''}
            </option>
          ))}
        </NativeSelect>
      </div>
      <p className="text-meta text-text-tertiary">
        A higher bitrate sounds clearer and uses more upload bandwidth.
      </p>
      <div className="flex items-center gap-3">
        <Switch
          id={`${id}-echo`}
          checked={echoCancellation}
          onCheckedChange={setEchoCancellation}
        />
        <label htmlFor={`${id}-echo`} className="text-label cursor-pointer">
          Echo cancellation
        </label>
      </div>
    </section>
  )
}
