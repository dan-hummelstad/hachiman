import { useState } from 'react'
import { RefreshCw, ScreenShare, ScreenShareOff, SlidersHorizontal } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ScreenSourcePicker, type PickerState } from '@/components/voice/screen-source-picker'
import { StreamQualityFields } from '@/components/voice/stream-quality-fields'
import { voiceService } from '@/services/VoiceService'
import { usePlatform } from '@/shared/PlatformContext'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * Share-screen toggle, "Change source" while sharing, and the stream quality picker. Render only
 * while in voice. Hosts with their own source list (Electron) get the in-app picker; the browser
 * shows its own. A pick while sharing swaps the source without a stop.
 * `buttonClassName` restyles both buttons, for the control bar of the stage.
 */
export function ScreenShareControls({
  buttonClassName
}: {
  buttonClassName?: string
}): React.JSX.Element {
  const platform = usePlatform()
  const sharing = useVoiceStore((s) => s.localScreen !== null)
  const [picker, setPicker] = useState<PickerState | null>(null)

  const start = async (): Promise<void> => {
    try {
      const sources = await platform.getScreenSources()
      if (sources) setPicker({ sources, error: null })
      else await voiceService.startScreenShare()
    } catch (err) {
      console.warn('[voice] could not list screen sources', err)
      setPicker({
        sources: [],
        error:
          'Hachiman could not read your screens and windows. On macOS, allow Screen Recording in System Settings.'
      })
    }
  }

  return (
    <>
      <IconButton
        label={sharing ? 'Stop sharing' : 'Share your screen'}
        pressed={sharing}
        tone="online"
        className={buttonClassName}
        onClick={() => (sharing ? voiceService.stopScreenShare() : void start())}
      >
        {sharing ? <ScreenShareOff /> : <ScreenShare />}
      </IconButton>
      {sharing && (
        <IconButton label="Change source" className={buttonClassName} onClick={() => void start()}>
          <RefreshCw />
        </IconButton>
      )}
      <StreamQualityPicker className={buttonClassName} />
      <ScreenSourcePicker picker={picker} onClose={() => setPicker(null)} />
    </>
  )
}

function StreamQualityPicker({ className }: { className?: string }): React.JSX.Element {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <IconButton label="Stream quality" className={className}>
          <SlidersHorizontal />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent side="top" className="w-64 space-y-3">
        <p className="section-label">Stream quality</p>
        <StreamQualityFields />
        <p className="text-text-tertiary text-xs">
          Changes apply to a live share. Higher settings need more upload bandwidth.
        </p>
      </PopoverContent>
    </Popover>
  )
}
