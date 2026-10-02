import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ErrorText } from '@/components/ui/field'
import { ModalWindow } from '@/components/ui/modal-window'
import { StreamQualityFields } from '@/components/voice/stream-quality-fields'
import { voiceService } from '@/services/VoiceService'
import type { ScreenSource } from '@/shared/IPlatformService'
import { usePlatform } from '@/shared/PlatformContext'

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
      className="sm:max-w-[720px]"
      actions={
        <Button variant="ghost" onClick={onClose}>
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

  const pick = async (id: string): Promise<void> => {
    try {
      await platform.selectScreenSource(id)
    } catch (err) {
      console.warn('[voice] screen source unavailable', err)
      setFailed('That source is gone. Pick another one.')
      return
    }
    onClose()
    void voiceService.startScreenShare()
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
      <h3 className="text-muted-foreground mb-2 text-xs font-semibold">{title}</h3>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {sources.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              onClick={() => onPick(s.id)}
              className="hover:bg-accent/60 focus-visible:outline-ring flex w-full flex-col gap-1 border p-1.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2"
            >
              <img
                src={s.thumbnail}
                alt=""
                className="aspect-video w-full bg-black object-contain"
              />
              <span className="truncate text-xs">{s.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
