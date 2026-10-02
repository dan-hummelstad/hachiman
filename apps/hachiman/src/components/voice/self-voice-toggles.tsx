import { HeadphoneOff, Headphones, Mic, MicOff } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { voiceService } from '@/services/VoiceService'
import { useVoiceStore } from '@/stores/voiceStore'

/** My mute / deafen toggles (user panel and voice room). */
export function SelfVoiceToggles(): React.JSX.Element {
  const selfMute = useVoiceStore((s) => s.selfMute)
  const selfDeaf = useVoiceStore((s) => s.selfDeaf)
  return (
    <>
      <IconButton
        label={selfMute ? 'Unmute' : 'Mute'}
        pressed={selfMute}
        tone="danger"
        onClick={() => voiceService.toggleMute()}
      >
        {selfMute ? <MicOff /> : <Mic />}
      </IconButton>
      <IconButton
        label={selfDeaf ? 'Undeafen' : 'Deafen'}
        pressed={selfDeaf}
        tone="danger"
        onClick={() => voiceService.toggleDeaf()}
      >
        {selfDeaf ? <HeadphoneOff /> : <Headphones />}
      </IconButton>
    </>
  )
}
