import { Mic, MicOff, Headphones, HeadphoneOff, Radio } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUserStore } from '@/stores/userStore'
import { useServerStore } from '@/stores/serverStore'
import { voiceService } from '@/services/VoiceService'
import { cn } from '@/lib/utils'

interface VoiceControlsProps {
  /**
   * Compact mode renders only the mute/deafen buttons stacked vertically,
   * with no transmission indicator strip. Used by the 64px server rail.
   */
  compact?: boolean
}

/**
 * Mute / deafen toggles. Renders even when no server is selected — the
 * toggles flip user-preference state (userStore.selfMute/selfDeaf), and
 * `voiceService.toggle*` no-ops the server push when disconnected. When a
 * server is connected, the toggle also pushes the state.
 */
export function VoiceControls({ compact = false }: VoiceControlsProps): React.JSX.Element {
  const { micActive, voiceConnected, speakingUsers } = useVoiceStore(
    useShallow((s) => ({
      micActive: s.micActive,
      voiceConnected: s.voiceConnected,
      speakingUsers: s.speakingUsers
    }))
  )
  const selfMute = useUserStore((s) => s.selfMute)
  const selfDeaf = useUserStore((s) => s.selfDeaf)
  const selectedServerId = useServerStore((s) => s.selectedServerId)

  const isTransmitting = micActive && !selfMute && !selfDeaf && voiceConnected
  const receivingCount = speakingUsers.size

  const handleToggleMute = async (): Promise<void> => {
    await voiceService.toggleMute(selectedServerId)
  }

  const handleToggleDeaf = async (): Promise<void> => {
    await voiceService.toggleDeaf(selectedServerId)
  }

  if (compact) {
    return (
      <div className="flex flex-col items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-9 w-9 rounded-lg', selfMute && 'text-destructive')}
          onClick={handleToggleMute}
          title={selfMute ? 'Unmute' : 'Mute'}
        >
          {selfMute ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className={cn('h-9 w-9 rounded-lg', selfDeaf && 'text-destructive')}
          onClick={handleToggleDeaf}
          title={selfDeaf ? 'Undeafen' : 'Deafen'}
        >
          {selfDeaf ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
        </Button>
      </div>
    )
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
