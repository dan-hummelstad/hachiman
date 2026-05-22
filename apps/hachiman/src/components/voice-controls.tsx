import { Mic, MicOff, Headphones, HeadphoneOff, Radio } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useVoiceStore } from '@/stores/voiceStore'
import { useServerStore } from '@/stores/serverStore'
import { voiceService } from '@/services/VoiceService'
import { cn } from '@/lib/utils'

export function VoiceControls(): React.JSX.Element | null {
  const { selfMute, selfDeaf, micActive, voiceConnected, speakingUsers } = useVoiceStore()
  const { selectedServerId } = useServerStore()

  if (!selectedServerId) return null

  const isTransmitting = micActive && !selfMute && !selfDeaf && voiceConnected
  const receivingCount = speakingUsers.size

  const handleToggleMute = async (): Promise<void> => {
    await voiceService.toggleMute(selectedServerId)
  }

  const handleToggleDeaf = async (): Promise<void> => {
    await voiceService.toggleDeaf(selectedServerId)
  }

  return (
    <div className="flex items-center gap-1 p-2 border-t">
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8', selfMute && 'text-destructive')}
        onClick={handleToggleMute}
        title={selfMute ? 'Unmute' : 'Mute'}
      >
        {selfMute ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className={cn('h-8 w-8', selfDeaf && 'text-destructive')}
        onClick={handleToggleDeaf}
        title={selfDeaf ? 'Undeafen' : 'Deafen'}
      >
        {selfDeaf ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
      </Button>
      <div className="ml-auto flex items-center gap-1.5">
        {isTransmitting && (
          <span title="Transmitting voice">
            <Radio className="h-3.5 w-3.5 text-green-500 animate-pulse" />
          </span>
        )}
        {receivingCount > 0 && !selfDeaf && (
          <span
            className="text-xs text-muted-foreground tabular-nums"
            title={`${receivingCount} user${receivingCount !== 1 ? 's' : ''} speaking`}
          >
            {receivingCount}
          </span>
        )}
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            voiceConnected ? 'bg-green-500' : 'bg-muted-foreground'
          )}
          title={voiceConnected ? 'Voice connected' : 'Voice disconnected'}
        />
      </div>
    </div>
  )
}
