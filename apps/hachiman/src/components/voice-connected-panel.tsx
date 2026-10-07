import { useEffect, useState } from 'react'
import { AudioLines, HeadphoneOff, Headphones, Mic, MicOff, PhoneOff } from 'lucide-react'
import { IconButton } from '@/components/ui/icon-button'
import { CallSecurityBanner, CallSecuritySection } from '@/components/voice/call-security'
import { ScreenShareControls } from '@/components/voice/screen-share-controls'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useVoiceStore, type VoiceConnectionState } from '@/stores/voiceStore'
import { classifyQuality, fmtLoss, fmtMs, QUALITY_TIER_LABEL } from '@/lib/connection-quality'

type Phase = 'connected' | 'lost' | 'connecting'

const PHASE: Record<Phase, { label: string; className: string }> = {
  connected: { label: 'Voice connected', className: 'text-feature-voice-text' },
  lost: { label: 'Connection lost', className: 'text-dnd' },
  connecting: { label: 'Connecting…', className: 'text-idle' }
}

function phaseOf(state: VoiceConnectionState): Phase {
  if (state === 'connected') return 'connected'
  return state === 'failed' || state === 'disconnected' ? 'lost' : 'connecting'
}

/**
 * The voice dock at the foot of the sidebar (about 93 high, buttons 32): a green tinted card with
 * "Voice connected", the channel and guild, my call timer, then mic, deafen, share screen and
 * disconnect. Renders only while in voice. The title opens the details popover (connection stats
 * and the call encryption, with "Verify call", §12.5); its tooltip gives the connection quality.
 * The banner line shows the 4013 rejoin and 4012.
 */
export function VoiceDock(): React.JSX.Element | null {
  const channelId = useVoiceStore((s) => s.channelId)
  const guildId = useVoiceStore((s) => s.guildId)
  const state = useVoiceStore((s) => s.connectionState)
  const quality = useVoiceStore((s) => s.connectionQuality)
  const selfMute = useVoiceStore((s) => s.selfMute)
  const selfDeaf = useVoiceStore((s) => s.selfDeaf)
  const channelName = useChannelStore((s) =>
    channelId ? (s.channels.get(channelId)?.name ?? null) : null
  )
  const guildName = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.name ?? null) : null))
  if (!channelId) return null

  const phase = phaseOf(state)
  const tier = phase === 'connected' ? classifyQuality(quality) : 'unknown'

  return (
    <section
      aria-label="Voice"
      className="border-feature-voice/30 bg-feature-voice/10 shrink-0 border p-2.5"
    >
      <CallSecurityBanner className="pb-1.5" />
      <div className="flex items-center gap-2.5">
        <span className="bg-feature-voice/15 text-feature-voice flex size-8 shrink-0 items-center justify-center">
          <AudioLines className="size-4" />
        </span>
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Voice connection details"
                  className="rounded-control hover:bg-surface-hover -mx-1 flex min-w-0 flex-1 flex-col px-1 text-left"
                >
                  <span
                    className={cn(
                      'flex items-center gap-1.5 text-[14px] leading-5 font-extrabold',
                      PHASE[phase].className
                    )}
                  >
                    {PHASE[phase].label}
                  </span>
                  <span className="text-text-tertiary truncate text-xs leading-4">
                    {channelName ?? 'Voice'}
                    {guildName ? ` · ${guildName}` : ''}
                  </span>
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">
              {phase === 'connected'
                ? `${QUALITY_TIER_LABEL[tier]} connection · ${fmtMs(quality.rttMs)}`
                : PHASE[phase].label}
            </TooltipContent>
          </Tooltip>
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
            <CallSecuritySection />
          </PopoverContent>
        </Popover>
        <CallTimer key={channelId} />
      </div>
      <div
        className={cn(
          'mt-2.5 flex gap-1.5',
          '[&>button]:rounded-control [&>button]:bg-surface-hover [&>button]:text-text-secondary [&>button]:h-8 [&>button]:w-auto [&>button]:flex-1'
        )}
      >
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
        <ScreenShareControls />
        <IconButton
          label="Disconnect"
          onClick={() => voiceService.leaveVoice()}
          className="!bg-feature-danger/20 !text-feature-danger hover:!bg-feature-danger/30"
        >
          <PhoneOff />
        </IconButton>
      </div>
    </section>
  )
}

/** My time in this call, counted from when the dock mounted for the channel (client only, N17). */
function CallTimer(): React.JSX.Element {
  const [since] = useState(() => Date.now())
  const [now, setNow] = useState(since)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <span className="bg-feature-voice/15 text-feature-voice-text shrink-0 px-1.5 py-0.5 font-mono text-xs font-semibold tabular-nums">
      {formatElapsed(now - since)}
    </span>
  )
}

/** h:mm:ss, or m:ss under an hour. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

function QualityRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}
