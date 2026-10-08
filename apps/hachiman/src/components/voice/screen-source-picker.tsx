import { useId, useState } from 'react'
import { ScreenShare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ErrorText } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { StreamQualityFields } from '@/components/voice/stream-quality-fields'
import { voiceService } from '@/services/VoiceService'
import type { ScreenSource } from '@/shared/IPlatformService'
import { usePlatform } from '@/shared/PlatformContext'
import { usePrefsStore } from '@/stores/prefsStore'

/** Discord-style picker: screens, then windows, as thumbnails. A pick starts the share. */
/** What the open picker shows: the sources, or why there are none. */
export interface PickerState {
  sources: ScreenSource[]
  error: string | null
}

export function ScreenSourcePicker({
  picker,
  onClose
}: {
  /** null = closed. */
  picker: PickerState | null
  onClose: () => void
}): React.JSX.Element {
  return (
    <ModalWindow
      open={picker !== null}
      onClose={onClose}
      title="Share your screen"
      description="Pick a screen or a window. Only the people in this call can see it."
      icon={<ScreenShare />}
      feature="voice"
      className="sm:max-w-[640px]"
      actions={
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      {picker && <PickerBody {...picker} onClose={onClose} />}
    </ModalWindow>
  )
}

/** Inside the window's content, which unmounts on close, so `failed` starts fresh on each open. */
function PickerBody({
  sources,
  error,
  onClose
}: {
  sources: ScreenSource[]
  error: string | null
  onClose: () => void
}): React.JSX.Element {
  const platform = usePlatform()
  const [failed, setFailed] = useState<string | null>(null)
  const shareAudioPref = usePrefsStore((s) => s.shareScreenAudio)
  const setShareAudio = usePrefsStore((s) => s.setShareScreenAudio)
  const shareAudio = platform.screenShareAudio && shareAudioPref
  const audioId = useId()

  const pick = async (id: string): Promise<void> => {
    try {
      await platform.selectScreenSource(id, shareAudio)
    } catch (err) {
      console.warn('[voice] screen source unavailable', err)
      setFailed('That source is gone. Pick another one.')
      return
    }
    onClose()
    void voiceService.startScreenShare({ audio: shareAudio })
  }

  return (
    <>
      <div className="max-h-[60vh] space-y-4 overflow-y-auto">
        <ErrorText>{error ?? failed}</ErrorText>
        {(['screen', 'window'] as const).map((kind) => (
          <SourceGroup
            key={kind}
            title={kind === 'screen' ? 'Screens' : 'Windows'}
            sources={sources.filter((s) => s.kind === kind)}
            onPick={(id) => void pick(id)}
          />
        ))}
      </div>
      {platform.screenShareAudio && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={audioId}
            checked={shareAudioPref}
            onChange={(e) => setShareAudio(e.target.checked)}
          />
          <label htmlFor={audioId} className="text-label cursor-pointer">
            Share audio
          </label>
        </div>
      )}
      <StreamQualityFields />
    </>
  )
}

function SourceGroup({
  title,
  sources,
  onPick
}: {
  title: string
  sources: ScreenSource[]
  onPick: (id: string) => void
}): React.JSX.Element | null {
  if (sources.length === 0) return null
  return (
    <section>
      <h3 className="section-label mb-2">{title}</h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {sources.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(s.id)}
              className="rounded-option border-line-hairline hover:bg-surface-hover hover:border-feature-voice focus-visible:outline-line-focus flex w-full flex-col gap-1.5 border p-1.5 text-left transition-colors outline-none focus-visible:outline-2 focus-visible:outline-offset-1"
            >
              <img
                src={s.thumbnail}
                alt=""
                className="aspect-video w-full rounded-[6px] bg-black object-contain"
              />
              <span className="text-text-primary truncate px-0.5 text-xs font-semibold">
                {s.name}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
