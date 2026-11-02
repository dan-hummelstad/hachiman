import { PhoneOff } from 'lucide-react'
import { LiveDot } from '@/components/ui/live'
import { useCallParticipants } from '@/components/voice/use-call-security'
import { CallSecurityBanner, CallSecuritySection } from '@/components/voice/call-security'
import { ScreenShareControls } from '@/components/voice/screen-share-controls'
import { SelfVoiceToggles } from '@/components/voice/self-voice-toggles'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useElapsed } from '@/hooks/use-elapsed'
import { channelLabel } from '@/lib/model'
import { cn } from '@/lib/utils'
import { voiceService } from '@/services/VoiceService'
import { useChannelStore } from '@/stores/channelStore'
import { useGuildStore } from '@/stores/guildStore'
import { useUserStore } from '@/stores/userStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { classifyQuality, fmtLoss, fmtMs, QUALITY_TIER_LABEL } from '@/lib/connection-quality'
import { PHASE, phaseOf, type Phase } from '@/lib/voice-phase'

/** The first-line tone per phase: connected is live, connecting neutral, lost is the one `you`. */
export const PHASE_TONE: Record<Phase, string> = {
  connected: 'text-live-text',
  connecting: 'text-text-secondary',
  lost: 'text-you-text'
}

/** What the dock, the control bar and the voice bar say about my call. */
export function useCallMeta(): {
  channelName: string | null
  guildName: string | null
  count: number
  pingText: string | null
} {
  const channelId = useVoiceStore((s) => s.channelId)
  const guildId = useVoiceStore((s) => s.guildId)
  const quality = useVoiceStore((s) => s.connectionQuality)
  const channel = useChannelStore((s) => (channelId ? s.channels.get(channelId) : undefined))
  const channelName = channel ? channelLabel(channel).name || null : null
  const guildName = useGuildStore((s) => (guildId ? (s.guilds.get(guildId)?.name ?? null) : null))
  const participants = useCallParticipants(guildId, channelId ?? '')
  const count = participants ? participants.filter((p) => p.status !== 'leaving').length : 0
  const ping = fmtMs(quality.rttMs)
  return { channelName, guildName, count, pingText: quality.rttMs == null ? null : ping }
}

/**
 * The voice dock at the foot of the sidebar (44 high): a live-tinted band with a 2 px live edge.
 * Line 1 is "In call · <channel>" in mono caps, line 2 "Connected · <ping> · <guild>", then my
 * call timer, share, and a "Leave" chip. Mute and deafen sit in the user bar on desktop; here
 * they show on the mobile layout only. Renders only while in voice. The title opens the details
 * popover (connection stats and the call encryption, with "Verify call", §12.5); its tooltip gives
 * the connection quality. The banner line shows the 4013 rejoin and 4012.
 */
export function VoiceDock(): React.JSX.Element | null {
  const channelId = useVoiceStore((s) => s.channelId)
  const state = useVoiceStore((s) => s.connectionState)
  const quality = useVoiceStore((s) => s.connectionQuality)
  const { channelName, guildName, pingText } = useCallMeta()
  const myId = useUserStore((s) => s.me?.id)
  const speaking = useVoiceStore((s) => myId !== undefined && s.speaking.has(myId))
  if (!channelId) return null

  const phase = phaseOf(state)
  const tier = phase === 'connected' ? classifyQuality(quality) : 'unknown'
  const title =
    phase === 'connected'
      ? `In call · ${channelName ?? 'Voice'}`
      : phase === 'lost'
        ? 'Connection lost'
        : 'Connecting…'

  return (
    <section aria-label="Voice" className="border-live bg-live-tint shrink-0 border-l-2">
      <CallSecurityBanner className="px-3 pt-2" />
      <div className="mobile:h-14 mobile:px-4 flex h-11 items-center gap-2.5 px-3">
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label="Voice connection details"
                  className="rounded-control hover:bg-surface-hover -mx-1 flex min-w-0 flex-1 flex-col gap-0.5 px-1 text-left"
                >
                  <span
                    className={cn(
                      'truncate font-mono text-[9px] leading-3 font-semibold tracking-[1px] uppercase',
                      PHASE_TONE[phase]
                    )}
                  >
                    {title}
                  </span>
                  <span className="text-text-secondary flex min-w-0 items-center gap-1.5 text-[12px]">
                    {speaking && <LiveDot />}
                    <span className="truncate">
                      {phase === 'connected' ? 'Connected' : PHASE[phase].label}
                      {pingText ? ` · ${pingText}` : ''}
                      {guildName ? ` · ${guildName}` : ''}
                    </span>
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
              <span className="cap">Connection</span>
              <span className="text-text-tertiary text-xs">
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
        <CallTimer channelId={channelId} />
        <div className="flex items-center gap-1">
          <span className="mobile:contents hidden">
            <SelfVoiceToggles className="mobile:size-9 mobile:rounded-pill mobile:border mobile:border-live-line mobile:text-live-text mobile:hover:text-live-text mobile:aria-pressed:bg-live-tint mobile:aria-pressed:text-live-text" />
          </span>
          <ScreenShareControls
            toggleOnly
            buttonClassName="size-6 rounded-[4px] text-text-tertiary hover:text-text-primary aria-pressed:text-live-text mobile:size-9 mobile:rounded-pill mobile:border mobile:border-live-line mobile:text-live-text mobile:aria-pressed:bg-live-tint"
          />
          <button
            type="button"
            aria-label="Disconnect"
            onClick={() => voiceService.leaveVoice()}
            className="border-live text-live-text hover:bg-live-tint focus-visible:outline-line-focus mobile:size-[34px] mobile:rounded-pill mobile:border-0 mobile:bg-you mobile:text-on-you mobile:hover:bg-you/90 mobile:px-0 h-[23px] rounded-[4px] border px-[9px] font-mono text-[9.5px] font-[700] tracking-[0.8px] uppercase outline-none focus-visible:outline-2"
          >
            <span className="mobile:hidden">Leave</span>
            <PhoneOff aria-hidden className="mobile:block mx-auto hidden size-[15px]" />
          </button>
        </div>
      </div>
    </section>
  )
}

/**
 * My time in this call (N17): from my own VoiceState.joinedAt when the gateway sent one, else
 * from when this client joined (voiceStore), so a remount of the dock keeps the time. A mono live
 * label with no fill; `className` adds sizes (the voice bar).
 */
export function CallTimer({
  channelId,
  className
}: {
  channelId: string
  className?: string
}): React.JSX.Element {
  const localJoinedAt = useVoiceStore((s) => s.localJoinedAt)
  const joinedAt = useMyJoinedAt(channelId)
  const elapsed = useElapsed(joinedAt ?? localJoinedAt)
  return (
    <span
      className={cn(
        'text-live-text shrink-0 font-mono text-[10px] tracking-[0.7px] tabular-nums',
        className
      )}
    >
      {elapsed}
    </span>
  )
}

/** My VoiceState.joinedAt in `channelId` (ms), or null. */
function useMyJoinedAt(channelId: string): number | null {
  const myId = useUserStore((s) => s.me?.id)
  const joinedAt = useVoiceStore((s) => {
    if (!myId || !s.channelId) return undefined
    const vs = s.voiceStates.get(s.guildId ?? s.channelId)?.get(myId)
    return vs?.channelId === channelId ? vs.joinedAt : undefined
  })
  const t = joinedAt ? Date.parse(joinedAt) : NaN
  return Number.isNaN(t) ? null : t
}

function QualityRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-tertiary">{label}</span>
      <span className="font-mono text-[11px] text-text-secondary tabular-nums">{value}</span>
    </div>
  )
}
