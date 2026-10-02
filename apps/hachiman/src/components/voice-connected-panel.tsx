import { PhoneOff } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useVoiceStore, type VoiceConnectionState } from '@/stores/voiceStore'
import {
  classifyQuality,
  fmtLoss,
  fmtMs,
  QUALITY_TIER_LABEL,
  type QualityTier
} from '@/lib/connection-quality'

const BARS: Record<QualityTier, number> = { good: 3, fair: 2, poor: 1, unknown: 0 }
const BAR_COLOR: Record<QualityTier, string> = {
  good: 'bg-online',
  fair: 'bg-idle',
  poor: 'bg-dnd',
  unknown: 'bg-offline'
}

type Phase = 'connected' | 'lost' | 'connecting'

const PHASE: Record<Phase, { label: string; className: string }> = {
  connected: { label: 'Voice connected', className: 'text-online' },
  lost: { label: 'Connection lost', className: 'text-dnd' },
  connecting: { label: 'Connecting…', className: 'text-idle' }
}

function phaseOf(state: VoiceConnectionState): Phase {
  if (state === 'connected') return 'connected'
  return state === 'failed' || state === 'disconnected' ? 'lost' : 'connecting'
}

/**
 * "Voice connected" panel at the bottom of the channel sidebar (spec §4).
 * Renders only while in voice. Mute / deafen live in the user panel below it.
 */
export function VoiceConnectedPanel(): React.JSX.Element | null {
  const channelId = useVoiceStore((s) => s.channelId)
  const guildId = useVoiceStore((s) => s.guildId)
  const state = useVoiceStore((s) => s.connectionState)
  const quality = useVoiceStore((s) => s.connectionQuality)
  const channelName = useChannelStore((s) =>
    channelId ? (s.channels.get(channelId)?.name ?? null) : null
  )
  const guildName = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.name ?? null) : null))
  if (!channelId) return null

  const phase = phaseOf(state)
  const tier = phase === 'connected' ? classifyQuality(quality) : 'unknown'

  return (
    <div className="flex shrink-0 items-center gap-2 border-t px-3 py-2">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Voice connection details"
            className="hover:bg-accent/60 -mx-1 flex min-w-0 flex-1 flex-col px-1 py-0.5 text-left"
          >
            <span
              className={cn(
                'flex items-center gap-1.5 text-[13px] leading-5 font-semibold',
                PHASE[phase].className
              )}
            >
              <SignalBars tier={tier} />
              {PHASE[phase].label}
            </span>
            <span className="text-muted-foreground truncate text-xs leading-4">
              {channelName ?? 'Voice'}
              {guildName ? ` / ${guildName}` : ''}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-60 p-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold">Connection</span>
            <span className="text-muted-foreground text-xs">
              {phase === 'connected' ? QUALITY_TIER_LABEL[tier] : state}
            </span>
          </div>
          <div className="mt-2 space-y-1.5 text-xs">
            <QualityRow label="Ping" value={fmtMs(quality.rttMs)} />
            <QualityRow label="Jitter" value={fmtMs(quality.jitterMs)} />
            <QualityRow label="Packet loss" value={fmtLoss(quality.packetLoss)} />
          </div>
        </PopoverContent>
      </Popover>
      <IconButton label="Disconnect" tone="danger" onClick={() => voiceService.leaveVoice()}>
        <PhoneOff />
      </IconButton>
    </div>
  )
}

/** Three ascending bars; filled count by quality tier. */
function SignalBars({ tier }: { tier: QualityTier }): React.JSX.Element {
  const filled = BARS[tier]
  return (
    <span aria-hidden className="flex h-3 items-end gap-px">
      {[5, 8, 11].map((h, i) => (
        <span
          key={h}
          className={cn('w-[3px]', i < filled ? BAR_COLOR[tier] : 'bg-border')}
          style={{ height: h }}
        />
      ))}
    </span>
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
