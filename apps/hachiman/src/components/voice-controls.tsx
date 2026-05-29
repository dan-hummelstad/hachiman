import { Mic, MicOff, Headphones, HeadphoneOff, Radio } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useVoiceStore } from '@/stores/voiceStore'
import { useUserStore } from '@/stores/userStore'
import { useServerStore } from '@/stores/serverStore'
import { voiceService } from '@/services/VoiceService'
import { cn } from '@/lib/utils'
import {
  classifyQuality,
  type ConnectionQuality,
  fmtLoss,
  fmtMs,
  QUALITY_TIER_COLOR,
  QUALITY_TIER_LABEL
} from '@/lib/connection-quality'

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
  // Single-value selector (stable reference): the connection-quality slot.
  const connectionQuality = useVoiceStore((s) => s.connectionQuality)

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
        <ConnectionQualityIndicator connected={voiceConnected} quality={connectionQuality} />
      </div>
    </div>
  )
}

/**
 * Small connection-status dot that opens a popover with client-side RTT /
 * jitter / packet-loss for the active voice session. When connected, the dot's
 * colour reflects the measured quality tier; when no stats have been measured
 * yet it stays neutral and the popover shows a clearly-marked "measuring /
 * unavailable" state rather than fabricated numbers. Consistent with the
 * compact control-bar styling.
 */
function ConnectionQualityIndicator({
  connected,
  quality
}: {
  connected: boolean
  quality: ConnectionQuality
}): React.JSX.Element {
  const tier = classifyQuality(quality)
  const hasSample = quality.sampledAt != null
  // Disconnected → neutral. Connected with a sample → tier colour. Connected
  // but unmeasured → green (we know the control channel is up, quality TBD).
  const dotColor = !connected
    ? 'bg-muted-foreground'
    : hasSample
      ? QUALITY_TIER_COLOR[tier]
      : 'bg-green-500'

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Connection quality"
          title={connected ? 'Connection quality' : 'Voice disconnected'}
          className="flex h-5 w-5 items-center justify-center rounded-sm hover:bg-accent"
        >
          <span className={cn('h-2 w-2 rounded-full', dotColor)} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-56 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">Connection</span>
          <span className="text-muted-foreground text-xs">
            {connected ? QUALITY_TIER_LABEL[tier] : 'Disconnected'}
          </span>
        </div>
        <div className="mt-2 space-y-1.5 text-xs">
          <QualityRow label="Ping (RTT)" value={fmtMs(quality.rttMs)} />
          <QualityRow label="Jitter" value={fmtMs(quality.jitterMs)} />
          <QualityRow label="Packet loss" value={fmtLoss(quality.packetLoss)} />
          {quality.transport != null && (
            <QualityRow label="Transport" value={quality.transport.toUpperCase()} />
          )}
        </div>
        {!hasSample && (
          <p className="text-muted-foreground mt-2 border-t pt-2 text-[11px] leading-snug">
            {connected
              ? 'Live stats not available yet — the client does not surface round-trip metrics through this build.'
              : 'Connect to a voice channel to measure connection quality.'}
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}

function QualityRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}
