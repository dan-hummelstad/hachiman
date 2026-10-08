import { HeadphoneOff, Headphones, Mic, MicOff } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { voiceService } from '@/services/VoiceService'
import { useServerVoice } from '@/components/voice/use-server-voice'
import { useVoiceStore } from '@/stores/voiceStore'

/**
 * My mute / deafen toggles (user panel and voice room). `className` restyles both buttons, for
 * the control bar of the stage.
 */
export function SelfVoiceToggles({ className }: { className?: string }): React.JSX.Element {
  const selfMute = useVoiceStore((s) => s.selfMute)
  const selfDeaf = useVoiceStore((s) => s.selfDeaf)
  const server = useServerVoice()
  const mute = selfMute || server.mute || server.deaf
  const deaf = selfDeaf || server.deaf
  return (
    <>
      <IconButton
        label={server.mute ? 'Server muted' : selfMute ? 'Unmute' : 'Mute'}
        pressed={mute}
        tone="danger"
        className={className}
        disabled={server.mute || server.deaf}
        onClick={() => voiceService.toggleMute()}
      >
        {mute ? <MicOff /> : <Mic />}
      </IconButton>
      <IconButton
        label={server.deaf ? 'Server deafened' : selfDeaf ? 'Undeafen' : 'Deafen'}
        pressed={deaf}
        tone="danger"
        className={className}
        disabled={server.deaf}
        onClick={() => voiceService.toggleDeaf()}
      >
        {deaf ? <HeadphoneOff /> : <Headphones />}
      </IconButton>
    </>
  )
}
