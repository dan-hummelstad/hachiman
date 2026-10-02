import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ErrorText, Field, SectionHeading } from '@/components/ui/field'
import { NativeSelect } from '@/components/ui/native-select'
import { useMicLevel } from '@/hooks/use-mic-level'
import { errMsg } from '@/lib/utils'
import { usePrefsStore } from '@/stores/prefsStore'

const canPickOutput =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

/** User settings → Voice and audio: input/output device + an opt-in mic check. */
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
    <div className="grid gap-8">
      <section className="grid grid-cols-2 gap-4">
        <DeviceSelect
          id="input-device"
          label="Input device"
          devices={inputs}
          value={inputDeviceId}
          onChange={setInputDeviceId}
          fallbackLabel="Microphone"
        />
        <DeviceSelect
          id="output-device"
          label="Output device"
          devices={outputs}
          value={outputDeviceId}
          onChange={setOutputDeviceId}
          fallbackLabel="Speaker"
          disabled={!canPickOutput}
          hint={canPickOutput ? undefined : 'This app can only play through the system default.'}
        />
      </section>
      {unlabeled && (
        <p className="text-muted-foreground text-xs leading-4">
          Device names are hidden until you allow microphone access. Use “Check microphone” below.
        </p>
      )}
      <ErrorText>
        {supported
          ? error
          : 'This app can’t list audio devices here, so the system default is used.'}
      </ErrorText>
      <MicCheck deviceId={inputDeviceId} onOpen={refresh} />
    </div>
  )
}

function DeviceSelect(props: {
  id: string
  label: string
  devices: MediaDeviceInfo[]
  value: string | null
  onChange: (id: string | null) => void
  fallbackLabel: string
  disabled?: boolean
  hint?: string
}): React.JSX.Element {
  const { id, label, devices, value, onChange, fallbackLabel, disabled, hint } = props
  const missing = value !== null && devices.length > 0 && !devices.some((d) => d.deviceId === value)
  return (
    <Field id={id} label={label} hint={hint}>
      <NativeSelect
        id={id}
        className="w-full"
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
    </Field>
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
    <section>
      <SectionHeading>Microphone check</SectionHeading>
      <div className="flex items-center gap-3">
        <Button variant={on ? 'default' : 'outline'} onClick={toggle}>
          {on ? 'Stop checking' : 'Check microphone'}
        </Button>
        <span
          role="meter"
          aria-label="Microphone level"
          aria-valuemin={0}
          aria-valuemax={100}
          className="bg-card relative h-3 flex-1 border"
        >
          <span ref={barRef} className="bg-online absolute inset-y-0 left-0 w-0" />
        </span>
      </div>
      <p className="text-muted-foreground mt-2 text-xs leading-4">
        Speak normally. The bar should move well past the first quarter.
      </p>
      <div className="mt-2">
        <ErrorText>{error}</ErrorText>
      </div>
    </section>
  )
}
