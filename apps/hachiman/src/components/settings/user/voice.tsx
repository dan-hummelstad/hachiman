import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AudioLines, Headphones, Mic } from 'lucide-react'
import { MobileField } from '@/components/mobile/field'
import { ListRow } from '@/components/mobile/list'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { Keycap } from '@/components/ui/keycap'
import { NativeSelect } from '@/components/ui/native-select'
import {
  FieldBlock,
  MobileCap,
  MobileCard,
  RangeInput,
  SelectRow,
  SettingsCap,
  SettingsRule,
  ToggleRow
} from '@/components/settings/user/rows'
import { SoundSettings, SoundSettingsMobile } from '@/components/settings/user/sounds'
import { useKeybindLabel } from '@/hooks/use-keybinds'
import { useLayout } from '@/hooks/use-layout'
import { useMicLevel } from '@/hooks/use-mic-level'
import { meterPercent } from '@/lib/input-sensitivity'
import { cn, errMsg } from '@/lib/utils'
import { usePlatform } from '@/shared/PlatformContext'
import { setSettingsSection } from '@/stores/navStore'
import { usePrefsStore, type NoiseSuppression } from '@/stores/prefsStore'

const canPickOutput =
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype

const NO_DEVICE_LIST = 'This app can’t list audio devices here, so the system default is used.'

/** User settings → Voice and audio: H6 on the desktop layout, M32 on the mobile layout. */
export function VoiceSection(): React.JSX.Element {
  return useLayout() === 'mobile' ? <VoiceMobile /> : <VoiceDesktop />
}

/** The audio devices, listed again on a device change and after the mic check opens the mic. */
function useAudioDevices(): {
  inputs: MediaDeviceInfo[]
  outputs: MediaDeviceInfo[]
  /** Without mic permission the browser hides device labels. */
  unlabeled: boolean
  /** False when the browser cannot list devices at all. */
  supported: boolean
  error: string | null
  refresh: () => void
} {
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
  const unlabeled = inputs.length > 0 && inputs.every((d) => !d.label)
  return { inputs, outputs, unlabeled, supported, error, refresh }
}

/** The devices side by side, an opt-in mic check, the voice options, sounds. */
function VoiceDesktop(): React.JSX.Element {
  const inputDeviceId = usePrefsStore((s) => s.inputDeviceId)
  const outputDeviceId = usePrefsStore((s) => s.outputDeviceId)
  const setInputDeviceId = usePrefsStore((s) => s.setInputDeviceId)
  const setOutputDeviceId = usePrefsStore((s) => s.setOutputDeviceId)
  const { inputs, outputs, unlabeled, supported, error, refresh } = useAudioDevices()

  return (
    <div>
      <SettingsCap>Devices</SettingsCap>
      <section className="mt-2 grid grid-cols-2 gap-4">
        <DeviceSelect
          id="input-device"
          label="Input"
          icon={<Mic />}
          devices={inputs}
          value={inputDeviceId}
          onChange={setInputDeviceId}
          fallbackLabel="Microphone"
        />
        <DeviceSelect
          id="output-device"
          label="Output"
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
        <p className="text-text-tertiary mt-2 text-[12.5px]">
          Device names are hidden until you allow microphone access. Use “Check microphone” below.
        </p>
      )}
      <ErrorText>{supported ? error : NO_DEVICE_LIST}</ErrorText>
      <SettingsRule />
      <SettingsCap>Check your setup</SettingsCap>
      <div className="mt-2">
        <MicCheck deviceId={inputDeviceId} onOpen={refresh} />
      </div>
      <SettingsRule />
      <SettingsCap>While you are in a room</SettingsCap>
      <div className="mt-1.5">
        <InputMode />
        <InputSensitivity />
        <NoiseSuppressionSelect />
        <AudioQuality />
      </div>
      <SettingsRule />
      <SoundSettings />
    </div>
  )
}

/**
 * Mobile: the devices as two touch selects (the iOS wheel), the mic test, noise suppression and
 * echo cancellation as switches, then the sounds. Input mode, sensitivity and quality stay on the desktop: their
 * defaults suit a phone, and push to talk needs a keybind, which the mobile layout does not have.
 */
function VoiceMobile(): React.JSX.Element {
  const ios = usePlatform().platform === 'ios'
  const inputDeviceId = usePrefsStore((s) => s.inputDeviceId)
  const outputDeviceId = usePrefsStore((s) => s.outputDeviceId)
  const setInputDeviceId = usePrefsStore((s) => s.setInputDeviceId)
  const setOutputDeviceId = usePrefsStore((s) => s.setOutputDeviceId)
  const { inputs, outputs, unlabeled, supported, error, refresh } = useAudioDevices()
  const echoCancellation = usePrefsStore((s) => s.echoCancellation)
  const setEchoCancellation = usePrefsStore((s) => s.setEchoCancellation)
  const id = useId()
  // iOS has no `setSinkId`: the output follows the system route (a route picker is spec §5).
  const showOutput = !ios && canPickOutput

  return (
    <div className="grid gap-[18px]">
      <section className="grid gap-2.5" aria-labelledby={`${id}-devices`}>
        <MobileCap id={`${id}-devices`}>Devices</MobileCap>
        <MobileField
          id={`${id}-input`}
          label="Input device"
          hint={
            !supported
              ? NO_DEVICE_LIST
              : unlabeled
                ? 'Device names show after you allow the microphone. Use “Check microphone” below.'
                : undefined
          }
          error={supported ? error : null}
        >
          <NativeSelect
            size="touch"
            lead={<Mic />}
            className="w-full"
            value={inputDeviceId ?? ''}
            onChange={(e) => setInputDeviceId(e.target.value || null)}
          >
            <DeviceOptions devices={inputs} value={inputDeviceId} fallbackLabel="Microphone" />
          </NativeSelect>
        </MobileField>
        {showOutput && (
          <MobileField id={`${id}-output`} label="Output device">
            <NativeSelect
              size="touch"
              lead={<Headphones />}
              className="w-full"
              value={outputDeviceId ?? ''}
              onChange={(e) => setOutputDeviceId(e.target.value || null)}
            >
              <DeviceOptions devices={outputs} value={outputDeviceId} fallbackLabel="Speaker" />
            </NativeSelect>
          </MobileField>
        )}
      </section>
      <section className="grid gap-1.5" aria-labelledby={`${id}-test`}>
        <MobileCap id={`${id}-test`}>Mic test</MobileCap>
        <MicCheck deviceId={inputDeviceId} onOpen={refresh} stopWhenHidden mobile />
      </section>
      <section className="grid gap-1.5" aria-labelledby={`${id}-processing`}>
        <MobileCap id={`${id}-processing`}>Voice processing</MobileCap>
        <MobileCard>
          <NoiseSuppressionRow />
          <ToggleRow
            title="Echo cancellation"
            checked={echoCancellation}
            onChange={setEchoCancellation}
          />
        </MobileCard>
      </section>
      <SoundSettingsMobile />
    </div>
  )
}

/** Voice activity sends when you speak; push to talk only while its key is held. */
function InputMode(): React.JSX.Element {
  const mode = usePrefsStore((s) => s.voiceInputMode)
  const setMode = usePrefsStore((s) => s.setVoiceInputMode)
  const key = useKeybindLabel('pushToTalk')
  const toKeybinds = (): void => setSettingsSection('keybinds')
  return (
    <ToggleRow
      title="Push to talk"
      hint={
        mode === 'pushToTalk' ? (
          <>
            {key ? (
              <>
                Hold <Keycap>{key}</Keycap> to talk.{' '}
              </>
            ) : (
              'No push-to-talk key is set, so your microphone stays closed. '
            )}
            <Button variant="link" className="h-auto p-0 text-[12.5px]" onClick={toKeybinds}>
              {key ? 'Change the key' : 'Set a key'}
            </Button>
            . It works only while the Hachiman window is focused.
          </>
        ) : (
          'Hold a key to open the mic. Otherwise it stays open.'
        )
      }
      checked={mode === 'pushToTalk'}
      onChange={(on) => setMode(on ? 'pushToTalk' : 'voiceActivity')}
    />
  )
}

/** Voice activity: how loud the mic must be to send, set by hand or learned from the room. */
function InputSensitivity(): React.JSX.Element | null {
  const mode = usePrefsStore((s) => s.voiceInputMode)
  const auto = usePrefsStore((s) => s.inputSensitivityAuto)
  const db = usePrefsStore((s) => s.inputSensitivityDb)
  const setAuto = usePrefsStore((s) => s.setInputSensitivityAuto)
  const setDb = usePrefsStore((s) => s.setInputSensitivityDb)
  if (mode !== 'voiceActivity') return null
  return (
    <>
      <ToggleRow
        title="Automatic input sensitivity"
        hint={
          auto
            ? 'Hachiman learns the noise of your room and sends your voice when you speak above it.'
            : 'Your microphone sends only when it is louder than this level.'
        }
        checked={auto}
        onChange={setAuto}
      />
      {!auto && (
        <FieldBlock label="Input sensitivity" className="pb-2">
          <div className="flex items-center gap-3">
            <RangeInput
              aria-label="Input sensitivity"
              fraction={(db + 100) / 100}
              min={-100}
              max={0}
              step={1}
              value={db}
              onChange={(e) => setDb(Number(e.target.value))}
            />
            <span className="text-text-secondary w-14 text-right text-[12.5px] tabular-nums">
              {db} dB
            </span>
          </div>
        </FieldBlock>
      )}
    </>
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
  return (
    <div className="grid gap-[7px]">
      <label
        htmlFor={id}
        className="text-text-disabled font-mono text-[9px] tracking-[1.2px] uppercase"
      >
        {label}
      </label>
      <NativeSelect
        id={id}
        lead={icon}
        className="w-full [&_select]:h-[42px]"
        value={value ?? ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <DeviceOptions devices={devices} value={value} fallbackLabel={fallbackLabel} />
      </NativeSelect>
      {hint && <p className="text-text-tertiary text-[12.5px]">{hint}</p>}
    </div>
  )
}

/** "System default", each device, and the saved device while it is unplugged. */
function DeviceOptions({
  devices,
  value,
  fallbackLabel
}: {
  devices: MediaDeviceInfo[]
  value: string | null
  fallbackLabel: string
}): React.JSX.Element {
  const missing = value !== null && devices.length > 0 && !devices.some((d) => d.deviceId === value)
  return (
    <>
      <option value="">System default</option>
      {devices.map((d, i) => (
        <option key={d.deviceId} value={d.deviceId}>
          {d.label || `${fallbackLabel} ${i + 1}`}
        </option>
      ))}
      {missing && <option value={value}>Disconnected device</option>}
    </>
  )
}

function NoiseSuppressionSelect(): React.JSX.Element {
  const value = usePrefsStore((s) => s.noiseSuppression)
  const setValue = usePrefsStore((s) => s.setNoiseSuppression)
  return (
    <SelectRow title="Noise suppression" hint="Filters fans, keyboards and the street outside.">
      <NativeSelect
        aria-label="Noise suppression"
        className="w-[220px]"
        value={value}
        onChange={(e) => setValue(e.target.value as NoiseSuppression)}
      >
        <option value="off">Off</option>
        <option value="browser">Standard (browser)</option>
        <option value="rnnoise">Enhanced (RNNoise)</option>
      </NativeSelect>
    </SelectRow>
  )
}

/**
 * Mobile: noise suppression as one switch. On is RNNoise; VoiceService falls back to the
 * browser's own suppression when the RNNoise worklet cannot load. A desktop "Standard" choice
 * also shows as on.
 */
function NoiseSuppressionRow(): React.JSX.Element {
  const value = usePrefsStore((s) => s.noiseSuppression)
  const setValue = usePrefsStore((s) => s.setNoiseSuppression)
  return (
    <ListRow
      icon={<AudioLines />}
      tile="neutral"
      label="Noise suppression"
      detail="Filters fans, keyboards and traffic"
      toggle={{
        checked: value !== 'off',
        onCheckedChange: (on) => setValue(on ? 'rnnoise' : 'off')
      }}
    />
  )
}

/**
 * Opt-in mic level meter: opens the selected input only while checking. With `stopWhenHidden`
 * (mobile) the check stops when the page hides: iOS pauses the capture in the background, so the
 * meter would hang.
 */
function MicCheck({
  deviceId,
  onOpen,
  stopWhenHidden = false,
  mobile = false
}: {
  deviceId: string | null
  onOpen: () => void
  stopWhenHidden?: boolean
  mobile?: boolean
}): React.JSX.Element {
  const barRef = useRef<HTMLSpanElement>(null)
  const markRef = useRef<HTMLSpanElement>(null)
  const { on, toggle, error } = useMicLevel(deviceId, barRef, markRef, onOpen)
  const voiceActivity = usePrefsStore((s) => s.voiceInputMode === 'voiceActivity')
  const auto = usePrefsStore((s) => s.inputSensitivityAuto)
  const db = usePrefsStore((s) => s.inputSensitivityDb)

  useEffect(() => {
    if (!stopWhenHidden || !on) return
    // `toggle` flips: `pagehide` and `visibilitychange` can both come before the next render.
    let stopped = false
    const stop = (): void => {
      if (stopped) return
      stopped = true
      toggle()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') stop()
    }
    window.addEventListener('pagehide', stop)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', stop)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [stopWhenHidden, on, toggle])

  return (
    <section
      className={cn(
        'grid gap-3 border p-[18px]',
        mobile && 'bg-surface-panel rounded-[14px] p-3.5',
        on ? 'bg-live-tint border-transparent' : 'border-line-hairline'
      )}
    >
      <div className="flex items-center gap-2.5">
        <Mic aria-hidden className={cn('size-3.5', on ? 'text-live' : 'text-text-tertiary')} />
        <span
          className={cn(
            'font-mono text-[9.5px] tracking-[1px] uppercase',
            on ? 'text-live-text font-semibold' : 'text-text-tertiary'
          )}
        >
          {on ? 'Mic check running · your mic is open' : 'Your mic is closed'}
        </span>
        <Button
          variant="secondary"
          size={mobile ? 'default' : 'sm'}
          onClick={toggle}
          className="ml-auto"
        >
          {on ? 'End check' : 'Check microphone'}
        </Button>
      </div>
      <span
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn(
          'bg-surface-sunken relative overflow-hidden [mask-image:repeating-linear-gradient(90deg,#000_0_15px,transparent_15px_19px)]',
          mobile ? 'h-[26px]' : 'h-[18px]'
        )}
      >
        <span
          ref={barRef}
          className="bg-text-disabled data-[open]:bg-live absolute inset-y-0 left-0 w-0"
        />
        {/* The threshold. Auto moves it from the hook; manual follows the slider. */}
        <span
          ref={markRef}
          aria-hidden
          hidden={!voiceActivity || (auto && !on)}
          style={auto ? undefined : { left: `${meterPercent(db)}%` }}
          className="bg-text-primary absolute inset-y-0 w-0.5"
        />
      </span>
      <p
        className={cn(
          'text-text-tertiary',
          mobile
            ? 'text-text-disabled font-mono text-[8.5px] tracking-[0.9px] uppercase'
            : 'text-[12.5px]'
        )}
      >
        {mobile
          ? 'Say something'
          : voiceActivity
            ? 'Say something. The meter turns teal while your microphone would send.'
            : 'Say something. The meter should move well into the bar.'}
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
  return (
    <>
      <ToggleRow
        title="Echo cancellation"
        hint="Keeps the sound of the room from coming back through your microphone."
        checked={echoCancellation}
        onChange={setEchoCancellation}
      />
      <SelectRow
        title="Audio quality"
        hint="A higher bitrate sounds clearer and uses more upload bandwidth."
      >
        <NativeSelect
          aria-label="Microphone bitrate"
          className="w-[220px]"
          value={String(micBitrate)}
          onChange={(e) => setMicBitrate(Number(e.target.value))}
        >
          {MIC_BITRATES.map((b) => (
            <option key={b} value={b}>
              {b / 1000} kbps{b === 64_000 ? ' (default)' : ''}
            </option>
          ))}
        </NativeSelect>
      </SelectRow>
    </>
  )
}
